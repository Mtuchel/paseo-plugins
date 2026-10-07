#!/usr/bin/env python3
"""Hourly ops digest (TUC-372): one Linear document answering "why is nothing landing?".

Run hourly at minute 5 (server087: systemd paseo-ops-digest.timer; formerly launchd sh.paseo.ops-digest
on the Mac). Each run:
  1. reads the repository part with tuchel-platform's `node tools/ci/ops-digest.mjs --json`
     (merge queue, drops, PRs open > 5 h, Railway deploys) in its own detached worktree at
     origin/main (never the shared local `main`, never `gt`);
  2. reads the Paseo agents of this host and of every host in ~/.paseo/ops-digest/remotes
     (over SSH, `--agents-json`): in error, waiting on the owner (permission or open plan
     review), ticket agents silent for more than 2 h, and tickets still labelled
     `<dispatch label>-running` without a live agent; and how many proposals in open
     "Decision candidates" tickets still wait for the owner's answer (TUC-748; a count only,
     never an attention item or notification);
  3. merges both into the state in ~/.paseo/ops-digest/state.json and saves it BEFORE
     publishing, so a failed publish never loses an observed problem. The same save holds this
     run's history lines in the state's outbox (`historyOutbox`): one `run` line with every unit
     read and its outcome, and one line per item (`opened`, `open`, `cleared`) with its kind,
     unit, ticket, host and whether the owner had to step in (`owner`) or automation acted
     (`auto`), never free text. Right after, they are appended to ~/.paseo/ops-digest/history.jsonl
     (lines of an earlier month to history-YYYY-MM.jsonl; at a month change history.jsonl is
     moved into its month's file) and leave the outbox only once written, so a failed append is
     retried next run (at most 72 runs wait; older ones become one `gap` line). The weekly
     review (linear-tickets `ops-review`) reads these files. Changing `item_kind()` starts new
     kinds in the history: earlier lines keep the old wording;
  4. rewrites the Linear document "Ops digest" (project Agent tooling) with the owner's key,
     including the week's trend from ~/.paseo/ops-digest/trend.json (written by the weekly
     review);
  5. inside the notification window (Mon-Fri 08:00-19:00 Europe/Berlin) posts one comment on
     the document as the Paseo app, mentioning the owner, listing the problems not delivered
     yet (also those that came and went overnight). Pending items are acknowledged only after
     that comment succeeded (at-least-once). When the app cannot post, a desktop notification
     says so once and the items stay pending.
  6. (first, scheduled runs only) starts tuchel-platform's "Flaky quarantine" workflow on main
     (TUC-614: GitHub starts that repository's schedules only about every 5 hours). A failed
     start is logged and never stops the digest.

A source that cannot be read keeps its previous items ("not refreshed since"). Raw error and
log text never reaches Linear: errors are reduced to categories, each line names the local
command that shows the details.

Flags: --print (render to stdout; publishes nothing, writes no state or history), --dry-run (log
what would be published and notified, write no state or history), --at <ISO time> (pretend
"now"; testing), --backfill-history (one-off migration: writes history-backfill.jsonl from the
items, pending and cleared entries in state.json, after copying state.json to
state.json.bak-<date>-backfill; refuses when history-backfill.jsonl exists).
"""
import fcntl
import glob
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

PASEO = os.path.expanduser("~/.local/bin/paseo")
HOME = os.path.expanduser("~/.paseo")
DIR = f"{HOME}/ops-digest"
STATE = f"{DIR}/state.json"
LOCK = f"{DIR}/lock"
WORKTREE = f"{DIR}/tuchel-platform"
# The clone the worktree hangs off: the Mac keeps it at ~/tuchel-platform, server087 at
# ~/paseo/tuchel-platform. OPS_DIGEST_REPO overrides.
REPO = os.environ.get("OPS_DIGEST_REPO") or next(
    (p for p in map(os.path.expanduser, ("~/tuchel-platform", "~/paseo/tuchel-platform")) if os.path.isdir(p)),
    os.path.expanduser("~/tuchel-platform"))
HOST_NAME = socket.gethostname().split(".")[0]
LOG = f"{HOME}/ops-digest.log"
LOG_MAX_BYTES = 2 * 2**20
CREDENTIALS = f"{HOME}/linear-tickets/credentials.json"
APP_TOKEN = f"{HOME}/linear-tickets/agent-app/token.json"
PLUGIN_SETTINGS = f"{HOME}/linear-tickets/settings.json"
REVIEWS = f"{HOME}/linear-tickets/plannotator/reviews.json"
# Other Paseo hosts whose agents this digest also covers: one SSH target per line (e.g.
# `mirko@45.154.33.85`). Each runs this script with --agents-json; its agents keep their host
# in `_host` so the digest names the right `paseo --host` command.
REMOTES = f"{DIR}/remotes"
TREND = f"{DIR}/trend.json"
PR_WATCH = f"{HOME}/linear-tickets/pr-watch.json"
CRASHES = f"{HOME}/linear-tickets/crash-recovery.json"
PULL_URL = "https://github.com/tuchel-sohn/tuchel-platform/pull/{}"
HISTORY = "history.jsonl"
HISTORY_BACKFILL = "history-backfill.jsonl"
HISTORY_OUTBOX_RUNS = 72  # runs kept for a later append; older ones become one gap line
LINEAR = "https://api.linear.app/graphql"
PROJECT_ID = "0f1ef7f6-a8d6-4fd5-bb7a-549344761229"  # Agent tooling
TITLE = "Ops digest"
TZ = ZoneInfo("Europe/Berlin")
WINDOW_DAYS = range(0, 5)  # Monday-Friday
WINDOW_HOURS = (8, 19)  # 08:00 <= now < 19:00
SILENT_S = 2 * 3600
SUBPROCESS_S = 60
# 2026-10-07: ops-digest.mjs took 336 s on the Mac with every unit fine; the old 300 s limit
# failed the whole repository part on most runs since ~2026-10-05.
REPO_SCRIPT_S = 600
HTTP_S = 30
PROBE_S = 2
RUN_BUDGET_S = 15 * 60
APP_TOKEN_MARGIN_S = 300
TICKET = re.compile(r"\b([A-Z][A-Z0-9]+)-(\d+)\b")
WORKTREE_TICKET = re.compile(r"/worktrees/[^/]+/[^/]*?\b([a-z][a-z0-9]+)-(\d+)-")
REPO_SECTIONS = ("main", "queue", "drops", "pulls", "deploys")
GITHUB_REPO = "tuchel-sohn/tuchel-platform"
QUARANTINE_WORKFLOW = "flaky-quarantine.yml"
HOST_UNITS = ("agents", "silent", "locks")
CANDIDATES_MARKER = re.compile(r"^Marker: `decision-candidates (?:ERP|Agent tooling) \d{4}-W\d{2}(?: run \d+)?`", re.M)
PROPOSAL = re.compile(r"^## Q-(\d+) — ", re.M)
ANSWERED = re.compile(r"\*\*Q-(\d+) answered\*\*")


def log(msg):
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    if os.path.exists(LOG) and os.path.getsize(LOG) > LOG_MAX_BYTES:
        os.replace(LOG, LOG + ".1")
    with open(LOG, "a") as f:
        f.write(f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}\n")


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(text):
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def local(ts, fmt="%H:%M"):
    return datetime.fromtimestamp(ts, TZ).strftime(fmt)


def in_window(ts):
    t = datetime.fromtimestamp(ts, TZ)
    return t.weekday() in WINDOW_DAYS and WINDOW_HOURS[0] <= t.hour < WINDOW_HOURS[1]


def age_text(seconds):
    return f"{int(seconds // 60)} min" if seconds < 2 * 3600 else f"{int(seconds // 3600)} h"


# ---------------------------------------------------------------------------- categories

def error_category(exc):
    """A failed read as a category; never the raw message (it can hold secrets)."""
    if isinstance(exc, subprocess.TimeoutExpired) or isinstance(exc, TimeoutError):
        return "timeout"
    if isinstance(exc, urllib.error.HTTPError):
        return "rate limit" if exc.code == 429 else f"HTTP {exc.code}"
    if isinstance(exc, urllib.error.URLError):
        return "network"
    if isinstance(exc, RateLimited):
        return "rate limit"
    if isinstance(exc, subprocess.CalledProcessError):
        return f"exit {exc.returncode}"
    if isinstance(exc, (json.JSONDecodeError, KeyError, TypeError)):
        return "unreadable response"
    if isinstance(exc, FileNotFoundError):
        return "missing file"
    return "error"


def agent_error_category(line):
    """The kind of an agent's last error line; the line itself is never published."""
    text = line or ""
    if not text.strip():
        return "no message"
    if re.search(r"\b429\b|rate.?limit|usage limit", text, re.I):
        return "rate limit"
    if re.search(r"overloaded|\b5\d\d\b|api error|provider|ECONN|network|timed? ?out|socket", text, re.I):
        return "provider or network error"
    if re.search(r"\btool\b", text, re.I):
        return "tool error"
    return "other error"


# ---------------------------------------------------------------------------- agents (pure)

def tickets_of(agent, meta, teams):
    cwd = os.path.expanduser(meta.get("cwd") or agent.get("cwd") or "")
    found = {f"{t}-{n}" for t, n in TICKET.findall(agent.get("name") or "")}
    found |= {f"{t.upper()}-{n}" for t, n in WORKTREE_TICKET.findall(cwd + "/")}
    label = (meta.get("labels") or {}).get("linear.identifier")
    if label:
        found.add(label)
    return {t for t in found if t.rsplit("-", 1)[0] in teams}


def is_subagent(meta):
    labels = meta.get("labels") or {}
    return bool(meta.get("internal")) or "paseo.parent-agent-id" in labels


def agent_title(agent):
    return f"agent {agent['id'][:7]} \"{(agent.get('name') or '')[:60]}\""


def agent_items(agents, metas, *, now, error_lines, permissions, open_reviews, teams, ticket_states):
    """Items for the agents section. `ticket_states` is None when Linear could not be read:
    then silent agents cannot be judged (their unit fails, previous items are kept).
    Closed agents are parked, not gone (paseo-archive-done.py closes long-idle ones; the next
    message loads them again), so they are judged for silence like idle ones."""
    items = []
    for agent in agents:
        meta = metas.get(agent["id"], {})
        if is_subagent(meta):
            continue
        tickets = sorted(tickets_of(agent, meta, teams))
        ticket = tickets[0] if tickets else None
        short = agent["id"][:7]
        paseo = f"paseo --host ssh://{agent['_host']}" if agent.get("_host") else "paseo"
        # Another host's agents carry its name in their unit, so an unreachable host keeps
        # only its own items (stale) while this host's items stay fresh.
        at_host = f"@{agent['_host']}" if agent.get("_host") else ""
        base = {"title": agent_title(agent), "ticket": ticket, "command": f"{paseo} logs {short} --tail 5"}
        if agent.get("status") == "error":
            items.append({**base, "key": f"agent-error:{agent['id']}", "unit": f"agents{at_host}", "section": "agents",
                          "group": "error", "attention": True,
                          "detail": f"in error: {agent_error_category(error_lines.get(agent['id']))}"})
        for perm in permissions.get(agent["id"], []):
            items.append({**base, "key": f"agent-waiting:{agent['id']}:{perm['id']}", "unit": f"agents{at_host}",
                          "section": "agents", "group": "waiting", "attention": True,
                          "detail": f"waits for your permission: {perm.get('name') or 'request'}",
                          "command": f"{paseo} permit ls"})
        review = open_reviews.get(agent["id"])
        if review:
            items.append({**base, "key": f"agent-waiting:{agent['id']}:{review.get('openedAt')}", "unit": f"agents{at_host}",
                          "section": "agents", "group": "waiting", "attention": True,
                          "detail": "waits for your plan review in Plannotator",
                          "command": "Plannotator (linear-tickets sidebar)"})
        if ticket_states is None or not tickets or agent.get("status") == "error":
            continue
        open_tickets = [t for t in tickets if ticket_states.get(t) not in ("completed", "canceled")]
        if not open_tickets:
            continue
        last = max(filter(None, [parse_iso(meta.get("lastActivityAt")), meta.get("_sessionMtime")]), default=None)
        if last is None or now - last <= SILENT_S:
            continue
        items.append({**base, "ticket": open_tickets[0], "key": f"agent-silent:{agent['id']}", "unit": f"silent{at_host}",
                      "section": "agents", "group": "silent", "attention": True,
                      "detail": f"{agent.get('status')}, no activity for {age_text(now - last)}"})
    return items


def lock_items(running_identifiers, agents, metas, teams):
    """Tickets labelled `<label>-running` with no unarchived agent on them (closed agents still hold theirs)."""
    held = set()
    for agent in agents:
        held |= tickets_of(agent, metas.get(agent["id"], {}), teams)
    return [{"key": f"lock-orphan:{ident}", "unit": "locks", "section": "agents", "group": "locks",
             "attention": True, "title": ident, "ticket": None,
             "detail": "labelled as having a running agent, but no agent works on it",
             "command": None}
            for ident in sorted(running_identifiers) if ident not in held]


# ---------------------------------------------------------------------------- decision candidates (pure)

def decision_candidates(issues):
    """Proposals still waiting for the owner's answer in open "Decision candidates" tickets
    (TUC-748): `## Q-<n> — ` headings in the description minus `**Q-<n> answered**` comments."""
    tickets = []
    for issue in issues:
        description = issue.get("description") or ""
        if not CANDIDATES_MARKER.search(description):
            continue
        asked = {int(n) for n in PROPOSAL.findall(description)}
        answered = set()
        for comment in (issue.get("comments") or {}).get("nodes") or []:
            answered |= {int(n) for n in ANSWERED.findall(comment.get("body") or "")}
        waiting = len(asked - answered)
        if waiting:
            tickets.append({"identifier": issue["identifier"], "url": issue.get("url"), "waiting": waiting})
    tickets.sort(key=lambda t: int(t["identifier"].rsplit("-", 1)[1]))
    return {"waiting": sum(t["waiting"] for t in tickets), "tickets": tickets}


# ---------------------------------------------------------------------------- state (pure)

def empty_state():
    return {"items": {}, "pending": {}, "cleared": [], "desktopNotified": None, "document": None,
            "publishedAt": None, "notifyFailedAt": None, "ownerUrl": None, "decisionCandidates": None,
            "historyOutbox": []}


def merge_decisions(state, decisions, now):
    """The latest decision-candidates count; a failed read (None) keeps the last one, marked stale.
    Never an item: it raises no attention and no notification."""
    if decisions is not None:
        state["decisionCandidates"] = {**decisions, "at": now, "stale": False}
    elif state.get("decisionCandidates"):
        state["decisionCandidates"] = {**state["decisionCandidates"], "stale": True}
    return state


def unit_failed(unit, failed_units):
    """Whether the read behind an item failed: its own unit, a parent unit (`pulls` covers
    `pulls/917`), or the whole repository script."""
    unit = unit or ""
    if "repo" in failed_units and unit.split("@")[0] not in HOST_UNITS:
        return True
    return any(unit == f or unit.startswith(f + "/") or unit.startswith(f + "@") for f in failed_units)


def merge_run(state, collected, failed_units, now):
    """Fold one run's items into the state. Items of failed units are kept with their last
    payload (marked stale); cleared items are reported once; new attention items join
    `pending` and stay there, with their payload, until a notification succeeds."""
    state = json.loads(json.dumps(state))
    previous = state["items"]
    items = {}
    for item in collected:
        prior = previous.get(item["key"])
        items[item["key"]] = {"payload": item, "firstSeen": prior["firstSeen"] if prior else now,
                              "lastSeen": now, "stale": False}
    # Cleared items stay listed until a document that shows them was published,
    # unless they came back.
    published = state.get("publishedAt")
    cleared = [c for c in state.get("cleared", [])
               if (published is None or c["clearedAt"] > published) and c["payload"]["key"] not in items]
    for key, entry in previous.items():
        if key in items:
            continue
        if unit_failed(entry["payload"].get("unit"), failed_units):
            items[key] = {**entry, "stale": True}
        else:
            cleared.append({**entry, "clearedAt": now})
            if key in state["pending"]:
                state["pending"][key]["clearedAt"] = now
    new_keys = [k for k, e in items.items() if k not in previous and e["payload"].get("attention")]
    for key in new_keys:
        state["pending"][key] = {"payload": items[key]["payload"], "firstSeen": now, "clearedAt": None}
    state["items"] = items
    state["cleared"] = cleared
    return state, new_keys


# ---------------------------------------------------------------------------- rendering (pure)

def line(payload, *, new=False, stale_since=None, agent_note=None):
    parts = [f"- {'**new** ' if new else ''}{payload.get('title')}"]
    if payload.get("ticket"):
        parts.append(f" {payload['ticket']}")
    if payload.get("age"):
        parts.append(f" (open {payload['age']})")
    parts.append(f": {payload.get('detail')}")
    if payload.get("reason"):
        parts.append(f" — queue said: {payload['reason']}")
    if agent_note:
        parts.append(f" — {agent_note}")
    if stale_since:
        parts.append(f" _(not refreshed since {stale_since})_")
    if payload.get("command"):
        parts.append(f" — `{payload['command']}`")
    elif payload.get("url"):
        parts.append(f" — {payload['url']}")
    return "".join(parts)


AGENT_GROUPS = [("error", "In error"), ("waiting", "Waiting on you"), ("silent", "Ticket agents silent > 2 h"),
                ("locks", "Tickets marked running without an agent")]
SECTION_TITLES = [("queue", "Merge queue"), ("pulls", "Pull requests open > 5 h"),
                  ("deploys", "Deploys (staging, production)"), ("agents", "Agents")]


NOT_ENOUGH_DATA = " _(not enough data)_"
TREND_KINDS = 5


def trend_lines(trend):
    """The "## Trend" block from trend.json (written weekly by the review); None: not computed yet.
    Raises on a malformed trend, so load_trend() can reject it before rendering."""
    if trend is None:
        return ["## Trend", "", "- Trend: not computed yet", ""]

    def num(value, fmt="{}"):
        return "unknown" if value is None else fmt.format(value)

    def mark(entry):
        return "" if entry.get("complete") else NOT_ENOUGH_DATA

    def owner(h):
        return (f"{num(h.get('ownerPerMergedPr'), '{:.2f}')} ({num(h.get('ownerTrue'))} of "
                f"{num(h.get('mergedPrs'))} merged PRs){mark(h)}")

    def share(h):
        value = h.get("shareClearedWithoutOwner")
        return (f"{num(None if value is None else round(value * 100), '{} %')} ({num(h.get('clearedWithoutOwner'))} of "
                f"{num(h.get('clearedKnownOwner'))} with known owner, {num(h.get('clearedUnknownOwner'))} unknown){mark(h)}")

    def median(h):
        return f"{num(h.get('medianHoursToClear'), '{:.1f} h')}{mark(h)}"

    this, last = trend["headline"]["this"], trend["headline"]["last"]
    out = [f"## Trend (week to {local(parse_iso(trend['window']['this']['to']), '%d.%m.%Y')})", "",
           f"- Problems that needed you per merged PR (observed owner involvement): {owner(this)} — last week {owner(last)}",
           f"- Share of problems cleared without you: {share(this)} — last week {share(last)}",
           f"- Median time to clear: {median(this)} — last week {median(last)}",
           "- Top kinds this week vs last week:"]
    out += [f"  - {k['kind']}: {num(k.get('thisWeek'))} vs {num(k.get('lastWeek'))}{mark(k)}"
            for k in (trend.get("kinds") or [])[:TREND_KINDS]] or ["  - none"]
    out.append("")
    return out


def render(state, units, now, *, new_keys=(), agent_notes=None, notify_failed=False, trend=None):
    agent_notes = agent_notes or {}
    entries = state["items"]

    def fmt(key):
        e = entries[key]
        p = e["payload"]
        return line(p, new=key in new_keys, stale_since=local(e["lastSeen"]) if e.get("stale") else None,
                    agent_note=agent_notes.get(p.get("ticket")) if p.get("section") != "agents" else None)

    def keys(pred):
        return sorted((k for k, e in entries.items() if pred(e["payload"])),
                      key=lambda k: (entries[k]["payload"].get("since") or "", k))

    out = [f"Collected {local(now, '%a %d.%m. %H:%M')} Berlin ({iso(now)}) by the hourly job on {HOST_NAME}. "
           "Run it yourself: `node tools/ci/ops-digest.mjs` in tuchel-platform, "
           f"`python3 ~/.paseo/bin/paseo-ops-digest.py --print` on {HOST_NAME}.", ""]
    if notify_failed:
        out += ["> Notification pending: the Paseo app could not post; retried every hour.", ""]
    attention = keys(lambda p: p.get("attention"))
    out += [f"## Needs attention ({len(attention)})", ""]
    out += [fmt(k) for k in attention] or ["- nothing"]
    out.append("")
    for section, title in SECTION_TITLES:
        out += [f"## {title}", ""]
        if section == "queue":
            body = [fmt(k) for k in keys(lambda p: p.get("section") in ("main", "queue"))]
            drops = keys(lambda p: p.get("section") == "drops")
            body += [fmt(k) for k in drops if not entries[k]["payload"].get("resolved")]
            resolved = [entries[k]["payload"] for k in drops if entries[k]["payload"].get("resolved")]
            if resolved:
                body.append("- earlier drops, since re-queued or closed: " + ", ".join(
                    f"#{p.get('draft')}" + (f" ({p['jobs']})" if p.get("jobs") else "") for p in resolved))
        elif section == "pulls":
            body = []
            groups = {}
            for k in keys(lambda p: p.get("section") == "pulls"):
                groups.setdefault(entries[k]["payload"].get("group"), []).append(k)
            for bottom, members in groups.items():
                gt = entries[members[0]]["payload"].get("groupTicket")
                body.append(f"- stack from #{bottom}{' ' + gt if gt else ''}")
                body += ["  " + fmt(k) for k in members]
        elif section == "agents":
            body = []
            for group, label in AGENT_GROUPS:
                members = keys(lambda p, g=group: p.get("section") == "agents" and p.get("group") == g)
                if members:
                    body += [f"**{label}**", ""] + [fmt(k) for k in members] + [""]
        else:
            body = [fmt(k) for k in keys(lambda p, s=section: p.get("section") == s)]
        out += body or ["- none"]
        out.append("")
    out += ["## Decision candidates", ""]
    decisions = state.get("decisionCandidates")
    if decisions:
        links = ", ".join(f"[{t['identifier']}]({t['url']}) ({t['waiting']})" for t in decisions["tickets"])
        out.append(f"- Decision candidates waiting: {decisions['waiting']}" + (f" — {links}" if links else "")
                   + (f" _(not refreshed since {local(decisions['at'])})_" if decisions.get("stale") else ""))
    else:
        out.append("- Decision candidates waiting: not read yet")
    out.append("")
    out += trend_lines(trend)
    if state.get("cleared"):
        out += ["## Cleared since last update", ""]
        out += [line(e["payload"]) for e in state["cleared"]]
        out.append("")
    failed = [u for u in units if not u.get("ok")]
    if failed:
        out += ["## Not read this time", ""]
        out += [f"- {u['unit']}: {u.get('category', 'error')} (previous items kept)" for u in failed]
        out.append("")
    return "\n".join(out)


NOTIFY_ITEMS = 25  # item lines in one notification; the rest is summed up by kind
NOTIFY_KINDS = 15  # kinds listed with their counts; smaller ones are summed into one line
NOTIFY_MAX_CHARS = 20000  # hard cap: a too-large comment fails, and then pending grows forever


def item_kind(payload):
    """A coarse kind for summing items up and for the history: the section plus the detail with
    parenthesised specifics (nested ones too) removed, PR references as `#N` and every other
    number as `N`. Changing it starts new kinds in the history (earlier lines keep theirs)."""
    detail = str(payload.get("detail") or "")
    while re.search(r"\([^()]*\)", detail):
        detail = re.sub(r"\([^()]*\)", "", detail)
    detail = detail.replace("(", "").replace(")", "")
    detail = re.sub(r"#\d+", "#N", detail)
    detail = re.sub(r"\d+", "N", detail)
    detail = re.sub(r"\s+", " ", detail).strip(" ,;")
    return f"{payload.get('section')}: {detail[:90]}"


def notification_body(state, owner_url, doc_url, now):
    pending = state["pending"]
    lines = [f"{owner_url} Ops digest: {len(pending)} new" if owner_url
             else f"Ops digest: {len(pending)} new", ""]

    def entry_line(key):
        entry = pending[key]
        payload = entry["payload"]
        prefix = ""
        if entry.get("clearedAt"):
            prefix = f"(seen {local(entry['firstSeen'])}, cleared {local(entry['clearedAt'])}) "
        return line({**payload, "title": prefix + str(payload.get("title"))})

    ordered = sorted(pending, key=lambda k: pending[k]["firstSeen"])
    if len(ordered) <= NOTIFY_ITEMS:
        lines += [entry_line(k) for k in ordered]
    else:
        # Still-open items first (newest first), then items that came and went.
        still_open = [k for k in reversed(ordered) if not pending[k].get("clearedAt")]
        shown = still_open[:NOTIFY_ITEMS]
        kinds = {}
        for key in ordered:
            kind = item_kind(pending[key]["payload"])
            counts = kinds.setdefault(kind, [0, 0])
            counts[1 if pending[key].get("clearedAt") else 0] += 1
        ranked = sorted(kinds.items(), key=lambda kv: (-sum(kv[1]), kv[0]))
        lines += ["**By kind** (still open / came and went):", ""]
        lines += [f"- {o} / {c} — {kind}" for kind, (o, c) in ranked[:NOTIFY_KINDS]]
        if len(ranked) > NOTIFY_KINDS:
            rest = ranked[NOTIFY_KINDS:]
            lines.append(f"- {sum(o for _, (o, _c) in rest)} / {sum(c for _, (_o, c) in rest)} — "
                         f"{len(rest)} smaller kinds")
        lines += ["", f"**Newest still open** ({len(shown)} of {len(still_open)}):", ""]
        lines += [entry_line(k) for k in shown]
        hidden = len(ordered) - len(shown)
        lines += ["", f"{hidden} more not listed here; the document lists everything still open."]
    if doc_url:
        lines += ["", f"[Open the digest]({doc_url})"]
    body = "\n".join(lines)
    if len(body) > NOTIFY_MAX_CHARS:
        tail = f"\n\n… cut at {NOTIFY_MAX_CHARS} characters." + (f" [Open the digest]({doc_url})" if doc_url else "")
        body = body[:NOTIFY_MAX_CHARS - len(tail)].rsplit("\n", 1)[0] + tail
    return body


def pending_signature(state):
    return ",".join(sorted(state["pending"]))


# ---------------------------------------------------------------------------- history (pure)

PULL_KEY = re.compile(r"pr:(\d+):")
AGENT_KEY = re.compile(r"agent-(?:error|silent|waiting):([^:]+)")


def item_host(payload, host):
    """The host an item belongs to: the part of its unit after the first `@` (another host's
    agents), `host` (this one) for its own agents, None for repository items."""
    unit = str(payload.get("unit") or "")
    if "@" in unit:
        return unit.split("@", 1)[1]
    return host if payload.get("section") == "agents" else None


def item_evidence(key, payload, at, host, evidence):
    """(owner, auto) as observed at this run. owner: the item waits on the owner, or its pull
    request watch / crash record escalated to the owner. auto: the watch nudged, handled a drop
    or ran a queue action, or the agent was restarted. None: unknown (another host's item, an
    unreadable record file, a kind without a record). Only these two flags leave the records."""
    waiting = True if payload.get("group") == "waiting" else None
    pull, agent = PULL_KEY.match(key), AGENT_KEY.match(key)
    if (at is not None and at != host) or not (pull or agent):
        return waiting, None
    records = evidence.get("prWatch") if pull else evidence.get("crashes")
    if records is None:
        return waiting, None
    record = records.get(PULL_URL.format(pull.group(1)) if pull else agent.group(1))
    record = record if isinstance(record, dict) else {}
    owner = waiting or bool(record.get("escalated"))
    if pull:
        nudges = record.get("nudges")
        auto = (isinstance(nudges, dict) and any(isinstance(v, list) and v for v in nudges.values())
                or bool(record.get("drops")) or bool(record.get("actions")))
    else:
        restarts = record.get("restarts")
        auto = isinstance(restarts, (int, float)) and restarts > 0
    return owner, bool(auto)


def item_line(event, key, payload, first_seen, t, at, *, stale, owner, auto):
    """One item's history line: fixed fields only, never title, detail, command or other text."""
    return {"t": iso(t), "event": event, "key": key, "kind": item_kind(payload), "unit": payload.get("unit"),
            "first": iso(first_seen), "attention": bool(payload.get("attention")), "section": payload.get("section"),
            "group": payload.get("group"), "ticket": payload.get("ticket"), "host": at, "stale": bool(stale),
            "owner": owner, "auto": auto}


def hosts_read(units, host):
    """`host` and every other host whose agents were read this run; [] when the agents were not."""
    if not any(u["unit"] == "agents" and u.get("ok") for u in units):
        return []
    return [host] + [u["unit"].split("@", 1)[1] for u in units if u["unit"].startswith("agents@") and u.get("ok")]


def history_events(previous_items, merged, units, now, *, host, read_hosts, evidence):
    """This run's history lines: first the `run` line (every unit read and whether it was, plus
    `pulls/<n>` for each pull request with a fresh item), then per item sorted by key `opened`
    (new), `open` (still there; `stale` when its unit failed) or `cleared` (gone).
    `evidence` = {"prWatch": dict|None, "crashes": dict|None} as read at this run."""
    outcome = {}
    for u in units:
        outcome[u["unit"]] = outcome.get(u["unit"], True) and bool(u.get("ok"))
    items = merged["items"]
    for entry in items.values():
        unit = str(entry["payload"].get("unit") or "")
        if unit.startswith("pulls/") and not entry.get("stale"):
            outcome.setdefault(unit, True)
    lines = [{"t": iso(now), "event": "run", "host": host, "units": outcome, "hosts": sorted(read_hosts),
              "items": len(items)}]
    for key in sorted(set(items) | set(previous_items)):
        if key in items:
            entry, event, stale = items[key], "open" if key in previous_items else "opened", items[key].get("stale")
        else:
            entry, event, stale = previous_items[key], "cleared", False
        payload = entry["payload"]
        at = item_host(payload, host)
        owner, auto = item_evidence(key, payload, at, host, evidence)
        lines.append(item_line(event, key, payload, entry["firstSeen"], now, at, stale=stale, owner=owner, auto=auto))
    return lines


def run_time(run):
    return next((line_["t"] for line_ in run if line_.get("event") == "run"), run[0]["t"])


def cap_outbox(outbox, limit=HISTORY_OUTBOX_RUNS):
    """At most `limit` runs wait for an append. Older ones are dropped and named by one `gap`
    run first; a gap already there keeps its start and moves its end."""
    gap = outbox[0] if outbox and outbox[0][0].get("event") == "gap" else None
    runs = outbox[1:] if gap else outbox
    if len(runs) <= limit:
        return outbox
    dropped, runs = runs[:-limit], runs[-limit:]
    if gap:
        gap = [{**gap[0], "to": run_time(dropped[-1])}]
    else:
        gap = [{"t": dropped[0][0]["t"], "event": "gap", "from": run_time(dropped[0]), "to": run_time(dropped[-1])}]
    return [gap] + runs


def backfill_events(state, host):
    """History lines rebuilt from a state (one-off migration): one `opened` line per distinct
    (key, firstSeen) of its items, cleared entries and pending items, and its `cleared` line
    when the clearing time is known. Owner and automation are unknown then."""
    found = {}
    sources = [(k, e.get("payload"), e.get("firstSeen"), None) for k, e in (state.get("items") or {}).items()]
    sources += [((e.get("payload") or {}).get("key"), e.get("payload"), e.get("firstSeen"), e.get("clearedAt"))
                for e in state.get("cleared") or []]
    sources += [(k, e.get("payload"), e.get("firstSeen"), e.get("clearedAt"))
                for k, e in (state.get("pending") or {}).items()]
    for key, payload, first, cleared in sources:
        if not key or not payload or first is None:
            continue
        entry = found.setdefault((key, first), [payload, None])
        if entry[1] is None:
            entry[1] = cleared
    lines = []
    for (key, first), (payload, cleared) in found.items():
        at = item_host(payload, host)
        for event, t in [("opened", first)] + ([("cleared", cleared)] if cleared is not None else []):
            lines.append({**item_line(event, key, payload, first, t, at, stale=False, owner=None, auto=None),
                          "src": "backfill"})
    lines.sort(key=lambda line_: (line_["t"], line_["key"]))
    return lines


# ---------------------------------------------------------------------------- side effects

class RateLimited(Exception):
    pass


def linear_call(auth, query, variables=None):
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(LINEAR, data=body, headers={"Content-Type": "application/json", "Authorization": auth})
    with urllib.request.urlopen(req, timeout=HTTP_S) as resp:
        payload = json.load(resp)
    errors = payload.get("errors") or []
    if errors:
        codes = {(e.get("extensions") or {}).get("code") for e in errors}
        if "RATELIMITED" in codes:
            raise RateLimited()
        raise LinearError(errors[0].get("message", "error"))
    return payload["data"]


class LinearError(Exception):
    pass


def owner_key():
    key = os.environ.get("LINEAR_API_KEY", "").strip()
    if key:
        return key
    with open(CREDENTIALS) as f:
        return json.load(f)["apiKey"]


def app_auth(now):
    """The Paseo app's access token while it is valid for a while; never refreshed here (the
    plugin owns its rotating refresh token)."""
    try:
        with open(APP_TOKEN) as f:
            token = json.load(f)
    except (OSError, ValueError):
        return None
    expires = (token.get("expires_at") or 0) / 1000
    if not token.get("access_token") or expires - now < APP_TOKEN_MARGIN_S:
        return None
    return f"Bearer {token['access_token']}"


def run_cmd(args, timeout=SUBPROCESS_S, cwd=None):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, cwd=cwd, check=True).stdout


class HostIO:
    """Real collectors and publishers; tests inject a fake with the same methods."""

    def __init__(self, sync_repo=True, remotes=True):
        self.sync_repo = sync_repo
        self._key = None
        self._remotes = None if remotes else []
        self._targets = None if remotes else []
        self._unreachable = {}

    def remote_targets(self):
        """The SSH targets of the other hosts in REMOTES (read once per run)."""
        if self._targets is None:
            try:
                with open(REMOTES) as f:
                    self._targets = [line.strip() for line in f if line.strip() and not line.startswith("#")]
            except OSError:
                self._targets = []
        return list(self._targets)

    def remotes(self):
        """Agent snapshots of the other hosts (read once per run). A host that cannot be read
        (the Mac asleep or offline) is skipped and named by unreachable_hosts(): only its own
        items are kept stale, the other hosts' items still refresh."""
        if self._remotes is None:
            self._remotes = []
            for target in self.remote_targets():
                try:
                    out = run_cmd(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", target,
                                   "bash -lc 'python3 .paseo/bin/paseo-ops-digest.py --agents-json'"])
                    snapshot = json.loads(out.strip().splitlines()[-1])
                except Exception as exc:
                    self._unreachable[target] = error_category(exc)
                    continue
                for agent in snapshot["agents"]:
                    agent["_host"] = target
                self._remotes.append(snapshot)
        return self._remotes

    def unreachable_hosts(self):
        """{ssh target: error category} of remotes that could not be read this run."""
        self.remotes()
        return dict(self._unreachable)

    def evidence(self):
        """The pull request watch and crash recovery records of the linear-tickets plugin, as
        they are now (each None when unreadable); history lines keep only owner/auto flags."""
        found = {}
        for name, path in (("prWatch", PR_WATCH), ("crashes", CRASHES)):
            try:
                with open(path) as f:
                    data = json.load(f)
            except (OSError, ValueError):
                data = None
            found[name] = data if isinstance(data, dict) else None
        return found

    def snapshot(self):
        """This host's agent data for another host's digest (--agents-json)."""
        agents, metas = self.agents()
        live_ids = {a["id"] for a in agents if a.get("status") != "closed"}
        return {"agents": agents, "metas": metas, "permissions": self.permissions(),
                "reviews": self.open_reviews(live_ids),
                "errorLines": {a["id"]: self.error_line(a["id"]) for a in agents if a.get("status") == "error"}}

    def key(self):
        if self._key is None:
            self._key = owner_key()
        return self._key

    def repo_digest(self):
        if not os.path.isdir(WORKTREE):
            run_cmd(["git", "-C", REPO, "fetch", "--quiet", "origin", "main"])
            run_cmd(["git", "-C", REPO, "worktree", "add", "--detach", WORKTREE, "origin/main"])
        elif self.sync_repo:
            # The data comes from live APIs; a failed fetch only means the script itself may be
            # an hour behind, so the run goes on with the worktree it has (2026-10-01 15:05: a
            # fetch hung past its timeout and the whole repository part went unread).
            try:
                run_cmd(["git", "-C", REPO, "fetch", "--quiet", "origin", "main"])
                run_cmd(["git", "-C", WORKTREE, "checkout", "--quiet", "--detach", "origin/main"])
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
                log(f"WARN worktree not updated ({error_category(exc)}); running the script it has")
        # stdout goes to a file, not a pipe: ops-digest.mjs calls process.exit() right after
        # writing its JSON, and node drops what a pipe has not taken yet (on Linux after 64 KB;
        # the JSON is ~165 KB since 2026-10-06, so every run on server087 read a cut line).
        with tempfile.TemporaryFile(mode="w+") as stdout:
            subprocess.run(["node", "tools/ci/ops-digest.mjs", "--json"], stdout=stdout, stderr=subprocess.PIPE,
                           text=True, timeout=REPO_SCRIPT_S, cwd=WORKTREE, check=True)
            stdout.seek(0)
            out = stdout.read()
        return json.loads(out.strip().splitlines()[-1])

    def agents(self):
        agents = json.loads(run_cmd([PASEO, "ls", "-g", "--json"]) or "[]")
        metas = {}
        live = {a["id"] for a in agents}
        for path in glob.glob(f"{HOME}/agents/*/*.json"):
            agent_id = os.path.basename(path)[:-5]
            if agent_id not in live:
                continue
            try:
                with open(path) as f:
                    meta = json.load(f)
            except (OSError, ValueError):
                continue
            handle = (meta.get("persistence") or {}).get("nativeHandle")
            if handle and os.path.exists(handle):
                meta["_sessionMtime"] = os.path.getmtime(handle)
            metas[agent_id] = meta
        for snapshot in self.remotes():
            agents += snapshot["agents"]
            metas.update(snapshot["metas"])
        return agents, metas

    def dispatch_quarantine(self):
        run_cmd(["gh", "workflow", "run", QUARANTINE_WORKFLOW, "--ref", "main", "-R", GITHUB_REPO])

    def error_line(self, agent_id):
        for snapshot in self.remotes():
            if agent_id in snapshot["errorLines"]:
                return snapshot["errorLines"][agent_id]
        try:
            out = run_cmd([PASEO, "logs", agent_id, "--tail", "1", "--filter", "text"])
        except Exception:
            return None
        return out.strip().splitlines()[-1] if out.strip() else ""

    def permissions(self):
        perms = {}
        for p in json.loads(run_cmd([PASEO, "permit", "ls", "--json"]) or "[]"):
            perms.setdefault(p["agentId"], []).append(p)
        for snapshot in self.remotes():
            for agent_id, found in snapshot["permissions"].items():
                perms.setdefault(agent_id, []).extend(found)
        return perms

    def open_reviews(self, live_ids):
        found = {agent_id: review for snapshot in self.remotes()
                 for agent_id, review in snapshot["reviews"].items() if agent_id in live_ids}
        try:
            with open(REVIEWS) as f:
                reviews = json.load(f)
        except (OSError, ValueError):
            return found
        for url, review in reviews.items():
            agent_id = review.get("agentId")
            if agent_id not in live_ids:
                continue
            try:
                with urllib.request.urlopen(f"{url}/api/plan", timeout=PROBE_S) as resp:
                    if resp.status == 200:
                        found[agent_id] = review
            except Exception:
                continue
        return found

    def teams(self):
        data = linear_call(self.key(), "{ teams(first: 250) { nodes { key } } }")
        return {t["key"] for t in data["teams"]["nodes"]}

    def ticket_states(self, identifiers):
        states = {}
        by_team = {}
        for ident in identifiers:
            team, number = ident.rsplit("-", 1)
            by_team.setdefault(team, []).append(float(number))
        query = """query($team: String!, $numbers: [Float!]) {
          issues(first: 250, filter: { team: { key: { eq: $team } }, number: { in: $numbers } }) {
            nodes { identifier state { type } } } }"""
        for team, numbers in by_team.items():
            for start in range(0, len(numbers), 200):
                data = linear_call(self.key(), query, {"team": team, "numbers": numbers[start:start + 200]})
                for node in data["issues"]["nodes"]:
                    states[node["identifier"]] = node["state"]["type"]
        return states

    def running_locks(self):
        label = "paseo"
        try:
            with open(PLUGIN_SETTINGS) as f:
                label = (json.load(f).get("dispatch") or {}).get("label") or label
        except (OSError, ValueError):
            pass
        query = """query($label: String!) { issues(first: 250, filter: {
          labels: { name: { eq: $label } }, state: { type: { nin: ["completed", "canceled"] } } }) {
          nodes { identifier } } }"""
        data = linear_call(self.key(), query, {"label": f"{label}-running"})
        return {n["identifier"] for n in data["issues"]["nodes"]}

    def decision_candidates(self):
        """Open TUC "Decision candidates" tickets with their comments (TUC-748)."""
        query = """{ issues(first: 250, filter: { team: { key: { eq: "TUC" } },
          description: { contains: "decision-candidates " },
          state: { type: { nin: ["completed", "canceled", "duplicate"] } } }) {
          nodes { identifier url title description comments(first: 250) { nodes { body } } } } }"""
        return linear_call(self.key(), query)["issues"]["nodes"]

    def owner_url(self):
        return linear_call(self.key(), "{ viewer { url } }")["viewer"]["url"]

    def publish(self, document, content):
        """Create or rewrite the document; returns {id, url, documentContentId}."""
        fields = "id url documentContentId"
        if document:
            try:
                data = linear_call(self.key(), f"""mutation($id: String!, $input: DocumentUpdateInput!) {{
                  documentUpdate(id: $id, input: $input) {{ success document {{ {fields} }} }} }}""",
                                   {"id": document["id"], "input": {"content": content}})
                if data["documentUpdate"]["success"]:
                    return data["documentUpdate"]["document"]
            except LinearError as exc:
                if not re.search(r"not found|entity", str(exc), re.I):
                    raise
        data = linear_call(self.key(), f"""mutation($input: DocumentCreateInput!) {{
          documentCreate(input: $input) {{ success document {{ {fields} }} }} }}""",
                           {"input": {"title": TITLE, "projectId": PROJECT_ID, "content": content}})
        if not data["documentCreate"]["success"]:
            raise LinearError("document not created")
        return data["documentCreate"]["document"]

    def comment(self, auth, document, body):
        data = linear_call(auth, """mutation($input: CommentCreateInput!) {
          commentCreate(input: $input) { success comment { id } } }""",
                           {"input": {"documentContentId": document["documentContentId"], "body": body}})
        if not data["commentCreate"]["success"]:
            raise LinearError("comment not created")

    def desktop(self, text):
        if not shutil.which("osascript"):
            log(f"WARN no desktop on {HOST_NAME}: {text}")
            return
        subprocess.run(["osascript", "-e", f'display notification "{text}" with title "Ops digest" sound name "Basso"'],
                       capture_output=True, timeout=SUBPROCESS_S)

    def app_auth(self, now):
        return app_auth(now)


# ---------------------------------------------------------------------------- state file

def load_state(path):
    try:
        with open(path) as f:
            return {**empty_state(), **json.load(f)}
    except FileNotFoundError:
        return empty_state()


def save_state(state, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".state-")
    with os.fdopen(fd, "w") as f:
        json.dump(state, f, indent=1, sort_keys=True)
    os.replace(tmp, path)


def load_trend(path):
    """trend.json as the weekly review wrote it; None when missing, unreadable or malformed."""
    try:
        with open(path) as f:
            trend = json.load(f)
        trend_lines(trend)  # a trend that cannot be rendered counts as unreadable
        return trend
    except FileNotFoundError:
        return None
    except Exception as exc:
        log(f"WARN trend.json unreadable ({error_category(exc)})")
        return None


# ---------------------------------------------------------------------------- history files

def utc_month(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m")


def encode_line(line_):
    return (json.dumps(line_, separators=(",", ":"), sort_keys=True) + "\n").encode()


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read_back(f, size, n):
    """The last n bytes (all when the file is smaller) of the binary file f of `size` bytes."""
    start = max(0, size - n)
    f.seek(start)
    return f.read(size - start)


def written_already(f, size, encoded):
    """How many of the lines `encoded` (in order, from the first) the file already ends with:
    an append that went through while its outbox was not emptied afterwards."""
    if not size or not encoded:
        return 0
    tail = read_back(f, size, sum(map(len, encoded)) + 1)
    whole = len(tail) == size
    last_start = tail.rfind(b"\n", 0, len(tail) - 1) + 1
    if last_start == 0 and not whole:
        return 0  # the file's last line is longer than everything to write
    last = tail[last_start:]
    for k in range(len(encoded), 0, -1):
        if encoded[k - 1] != last:
            continue
        joined = b"".join(encoded[:k])
        before = len(tail) - len(joined)
        if tail.endswith(joined) and (tail[before - 1:before] == b"\n" if before > 0 else whole):
            return k
    return 0


def append_history(path, encoded):
    """Appends the encoded lines exactly once, fsynced. A torn last line (an interrupted append;
    its record is still in the outbox) is cut off first; lines the file already ends with are
    not written again."""
    with open(path, "a+b") as f:
        size = f.seek(0, os.SEEK_END)
        if size and read_back(f, size, 1) != b"\n":
            end = size
            while end > 0:
                start = max(0, end - 65536)
                f.seek(start)
                found = f.read(end - start).rfind(b"\n")
                if found >= 0:
                    end = start + found + 1
                    break
                end = start
            f.truncate(end)
            size = end
        f.write(b"".join(encoded[written_already(f, size, encoded):]))
        f.flush()
        os.fsync(f.fileno())


def rotate_history(history_dir, month):
    """When history.jsonl starts before `month`, each of its lines is appended to the file of its
    own month (history-YYYY-MM.jsonl, never overwritten); history.jsonl is removed only after
    that. A torn last line is left out: its record is still in the outbox."""
    path = os.path.join(history_dir, HISTORY)
    try:
        with open(path, "rb") as f:
            raw = f.read().split(b"\n")[:-1]
    except FileNotFoundError:
        return
    months = []
    for r in raw:
        try:
            months.append(str(json.loads(r)["t"])[:7])
        except (ValueError, KeyError, TypeError):
            months.append(months[-1] if months else None)  # stays with the line before it
    known = next((m for m in months if m), None)
    if known is None or known >= month:
        return
    targets = {}
    for r, m in zip(raw, months):
        targets.setdefault(m or known, []).append(r + b"\n")
    for m, encoded in targets.items():
        append_history(os.path.join(history_dir, f"history-{m}.jsonl"), encoded)
    os.remove(path)
    fsync_dir(history_dir)


def flush_history(state, history_dir, now):
    """Appends every outbox line to its month's history file (history.jsonl for the month of
    `now`, history-YYYY-MM.jsonl for earlier ones), then empties the outbox. Raises when a
    file cannot be written; the outbox is then kept for the next run."""
    outbox = state.get("historyOutbox") or []
    if not outbox:
        return
    month = utc_month(now)
    os.makedirs(history_dir, exist_ok=True)
    rotate_history(history_dir, month)
    targets = {}
    for run_ in outbox:
        for line_ in run_:
            m = str(line_["t"])[:7]
            name = HISTORY if m == month else f"history-{m}.jsonl"
            targets.setdefault(os.path.join(history_dir, name), []).append(encode_line(line_))
    for path, encoded in targets.items():
        append_history(path, encoded)
    fsync_dir(history_dir)
    state["historyOutbox"] = []


def backfill_history(state_path, history_dir, lock_path, now):
    """One-off migration (--backfill-history): history-backfill.jsonl from the state's items,
    pending and cleared entries, after copying state.json to state.json.bak-<date>-backfill.
    state.json is never written. Returns an exit code (75: the lock is held, 1: refused)."""
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    lock = open(lock_path, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("ops digest: another run holds the lock; try again in a minute", file=sys.stderr)
        lock.close()
        return 75
    try:
        target = os.path.join(history_dir, HISTORY_BACKFILL)
        if os.path.exists(target):
            print(f"ops digest: {target} exists; the backfill ran already", file=sys.stderr)
            return 1
        try:
            with open(state_path) as f:
                state = json.load(f)
        except (OSError, ValueError) as exc:
            print(f"ops digest: {state_path} not readable ({error_category(exc)})", file=sys.stderr)
            return 1
        shutil.copy2(state_path, f"{state_path}.bak-{datetime.fromtimestamp(now, timezone.utc):%Y%m%d}-backfill")
        lines = backfill_events(state, HOST_NAME)
        os.makedirs(history_dir, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=history_dir, prefix=".history-backfill-")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(b"".join(encode_line(line_) for line_ in lines))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, target)
        except BaseException:
            try:
                os.remove(tmp)
            except FileNotFoundError:
                pass
            raise
        fsync_dir(history_dir)
        print(f"ops digest: wrote {len(lines)} lines to {target}")
        return 0
    finally:
        lock.close()


# ---------------------------------------------------------------------------- one run

def collect(io, now, started):
    """All items and unit outcomes of one run. Every unit attempted is listed, read or not (the
    history's run line counts on it)."""
    items, units = [], []
    try:
        digest = io.repo_digest()
        items += digest["items"]
        units += digest["units"]
        units.append({"unit": "repo", "ok": True})
    except Exception as exc:
        units.append({"unit": "repo", "ok": False, "category": error_category(exc)})
    agents, metas = [], {}
    try:
        agents, metas = io.agents()
        permissions = io.permissions()
        live_ids = {a["id"] for a in agents if a.get("status") != "closed"}
        reviews = io.open_reviews(live_ids)
        error_lines = {a["id"]: io.error_line(a["id"]) for a in agents if a.get("status") == "error"}
        agents_ok = True
    except Exception as exc:
        units.append({"unit": "agents", "ok": False, "category": error_category(exc)})
        units.append({"unit": "silent", "ok": False, "category": "agents not read"})
        units.append({"unit": "locks", "ok": False, "category": "agents not read"})
        for target in io.remote_targets():
            units.append({"unit": f"agents@{target}", "ok": False, "category": "agents not read"})
            units.append({"unit": f"silent@{target}", "ok": False, "category": "agents not read"})
        agents_ok = False
    teams = None
    if agents_ok:
        units.append({"unit": "agents", "ok": True})
        states = None
        try:
            teams = io.teams()
            idents = set()
            for agent in agents:
                idents |= tickets_of(agent, metas.get(agent["id"], {}), teams)
            states = io.ticket_states(idents)
            units.append({"unit": "silent", "ok": True})
        except Exception as exc:
            units.append({"unit": "silent", "ok": False, "category": error_category(exc)})
        items += agent_items(agents, metas, now=now, error_lines=error_lines, permissions=permissions,
                             open_reviews=reviews, teams=teams or {"TUC"}, ticket_states=states)
        silent = units[-1]
        down = io.unreachable_hosts()
        for host, category in sorted(down.items()):
            units.append({"unit": f"agents@{host}", "ok": False, "category": category})
            units.append({"unit": f"silent@{host}", "ok": False, "category": category})
        for target in io.remote_targets():
            if target not in down:
                units.append({"unit": f"agents@{target}", "ok": True})
                units.append({**silent, "unit": f"silent@{target}"})
        try:
            if teams is None:
                raise LinearError("teams not read")
            if down:
                # Without every host's agents a held ticket would look orphaned.
                units.append({"unit": "locks", "ok": False, "category": "a host was not read"})
            else:
                items += lock_items(io.running_locks(), agents, metas, teams)
                units.append({"unit": "locks", "ok": True})
        except Exception as exc:
            units.append({"unit": "locks", "ok": False, "category": error_category(exc)})
    decisions = None
    try:
        decisions = decision_candidates(io.decision_candidates())
        units.append({"unit": "decision_candidates", "ok": True})
    except Exception as exc:
        units.append({"unit": "decision_candidates", "ok": False, "category": error_category(exc)})
    if time.monotonic() - started > RUN_BUDGET_S:
        raise TimeoutError("run budget exceeded")
    # Repository items name their ticket; the note says which agent works on it.
    agent_notes = {}
    for agent in agents:
        meta = metas.get(agent["id"], {})
        if is_subagent(meta):
            continue
        last = max(filter(None, [parse_iso(meta.get("lastActivityAt")), meta.get("_sessionMtime")]), default=None)
        for ticket in sorted(tickets_of(agent, meta, teams or {"TUC"})):
            note = f"agent {agent['id'][:7]} {agent.get('status')}" + (f", active {age_text(now - last)} ago" if last else "")
            agent_notes.setdefault(ticket, note)
    return items, units, agent_notes, decisions


def dispatch_quarantine(io):
    """Starts the hourly flaky-test quarantine job; a failure is only logged (TUC-614)."""
    try:
        io.dispatch_quarantine()
        log(f"dispatched {QUARANTINE_WORKFLOW}")
    except Exception as exc:
        log(f"WARN {QUARANTINE_WORKFLOW} not dispatched ({error_category(exc)})")


def run(io, *, now, mode="publish", state_path=STATE, lock_path=LOCK, started=None, history_dir=DIR,
        trend_path=TREND):
    """One digest run. mode: publish | print | dry-run. Returns an exit code. Only publish
    writes history (into `history_dir`); `trend_path` is the weekly review's trend.json."""
    started = started if started is not None else time.monotonic()
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    lock = open(lock_path, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log("skip: another run holds the lock")
        if mode != "publish":
            print("ops digest: another run holds the lock; try again in a minute", file=sys.stderr)
        lock.close()
        return 75
    try:
        state = load_state(state_path)
        if mode == "publish":
            dispatch_quarantine(io)
        items, units, agent_notes, decisions = collect(io, now, started)
        failed = {u["unit"] for u in units if not u.get("ok")}
        merged, new_keys = merge_run(state, items, failed, now)
        merged = merge_decisions(merged, decisions, now)
        content = render(merged, units, now, new_keys=new_keys, agent_notes=agent_notes,
                         notify_failed=bool(merged.get("notifyFailedAt")), trend=load_trend(trend_path))
        if mode == "print":
            print(content)
            return 0
        if mode == "dry-run":
            log(f"DRY RUN: {len(merged['items'])} items, {len(new_keys)} new, {len(merged['pending'])} pending, "
                f"window={'open' if in_window(now) else 'closed'}, failed units={sorted(failed)}")
            return 0
        # This run's history lines wait in the outbox, saved with the observations, until written.
        events = history_events(state["items"], merged, units, now, host=HOST_NAME,
                                read_hosts=hosts_read(units, HOST_NAME), evidence=io.evidence())
        merged["historyOutbox"] = cap_outbox(list(merged.get("historyOutbox") or []) + [events])
        save_state(merged, state_path)  # observations are durable before anything is published
        try:
            flush_history(merged, history_dir, now)
            save_state(merged, state_path)
        except Exception as exc:
            log(f"WARN history not written ({error_category(exc)})")  # the outbox keeps it for the next run
        try:
            merged["document"] = io.publish(merged.get("document"), content)
            merged["publishedAt"] = now
            save_state(merged, state_path)
        except Exception as exc:
            log(f"ERROR publish failed ({error_category(exc)}); state kept, next run retries")
            return 1
        if merged["pending"] and in_window(now):
            deliver(io, merged, now, state_path)
        log(f"ok: {len(merged['items'])} items, {len(new_keys)} new, {len(merged['pending'])} pending, "
            f"failed units={sorted(failed)}")
        return 0
    finally:
        lock.close()


def deliver(io, state, now, state_path):
    auth = io.app_auth(now)
    try:
        if auth is None:
            raise LinearError("app token unusable")
        if not state.get("ownerUrl"):
            state["ownerUrl"] = io.owner_url()
        io.comment(auth, state["document"], notification_body(state, state["ownerUrl"], state["document"].get("url"), now))
        state["pending"] = {}
        state["desktopNotified"] = None
        state["notifyFailedAt"] = None
    except Exception as exc:
        log(f"WARN notification failed ({error_category(exc)}); {len(state['pending'])} items stay pending")
        state["notifyFailedAt"] = now
        signature = pending_signature(state)
        if state.get("desktopNotified") != signature:
            io.desktop(f"{len(state['pending'])} new ops items; Linear notification failed")
            state["desktopNotified"] = signature
    save_state(state, state_path)


def main(argv):
    if "--agents-json" in argv:
        # Read by another host's digest (REMOTES): this host's agents only, nothing published.
        print(json.dumps(HostIO(sync_repo=False, remotes=False).snapshot()))
        return 0
    now = time.time()
    if "--at" in argv:
        now = parse_iso(argv[argv.index("--at") + 1])
    if "--backfill-history" in argv:
        return backfill_history(STATE, DIR, LOCK, now)
    mode = "print" if "--print" in argv else "dry-run" if "--dry-run" in argv else "publish"
    # Only the scheduled run moves the digest worktree to the latest origin/main.
    return run(HostIO(sync_repo=mode == "publish"), now=now, mode=mode)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as e:  # launchd job: always leave a trace in our own log
        log(f"ERROR {type(e).__name__}: {error_category(e)}")
        sys.exit(1)
