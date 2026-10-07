#!/usr/bin/env python3
"""Tests for paseo-ops-digest.py (TUC-372): python3 -m unittest ~/.paseo/bin/test_paseo_ops_digest.py

Stdlib only: a fake clock, injected collectors and a fake Linear client in a temp state dir.
"""
import contextlib
import fcntl
import importlib.util
import json
import io
import os
import subprocess
import tempfile
import unittest
from datetime import datetime
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("ops_digest", os.path.join(HERE, "paseo-ops-digest.py"))
digest = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(digest)


def at(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()


# Berlin is UTC+2 on these dates. 2026-09-30 is a Wednesday.
TUE_23_00 = at("2026-09-29T21:00:00Z")
WED_03_00 = at("2026-09-30T01:00:00Z")
WED_08_05 = at("2026-09-30T06:05:00Z")
WED_09_05 = at("2026-09-30T07:05:00Z")
WED_10_05 = at("2026-09-30T08:05:00Z")
WED_11_05 = at("2026-09-30T09:05:00Z")


def deploy_item(service, env="production", deployment="d1"):
    return {"key": f"deploy:{env}/{service}:{deployment}:failed", "unit": f"deploy:{env}/{service}",
            "section": "deploys", "attention": True, "title": f"{env} {service}", "detail": "FAILED (5f4ee94fe)",
            "command": f"railway logs {deployment}"}


def pr_item(number, kind="check-failed"):
    return {"key": f"pr:{number}:{kind}", "unit": f"pulls/{number}", "section": "pulls", "attention": True,
            "title": f"#{number}", "detail": "failed: ci / Lint", "group": number}


def candidates_ticket(number, questions, comments=(), project="ERP", week="2026-W41"):
    body = "\n\n".join(f"## Q-{q} — proposal {q}\n\nWhy it is general." for q in questions)
    return {"identifier": f"TUC-{number}", "url": f"https://linear.app/tuchel/issue/TUC-{number}",
            "title": f"Decision candidates, week {week[-2:]}",
            "description": f"Marker: `decision-candidates {project} {week}`\n\n{body}",
            "comments": {"nodes": [{"body": c} for c in comments]}}


class FakeIO:
    def __init__(self):
        self.repo_items = []
        self.repo_units = [{"unit": "main", "ok": True}]
        self.repo_error = None
        self.agent_list = []
        self.metas = {}
        self.error_lines = {}
        self.perms = {}
        self.locks = set()
        self.states = {}
        self.publish_error = None
        self.comment_error = None
        self.auth = "Bearer app"
        self.published = []
        self.comments = []
        self.desktops = []
        self.dispatches = 0
        self.dispatch_error = None
        self.candidates = []
        self.candidates_error = None
        self.unreachable = {}
        self.targets = []
        self.evidence_data = {"prWatch": None, "crashes": None}

    def dispatch_quarantine(self):
        self.dispatches += 1
        if self.dispatch_error:
            raise self.dispatch_error

    def repo_digest(self):
        if self.repo_error:
            raise self.repo_error
        return {"items": list(self.repo_items), "units": list(self.repo_units)}

    def agents(self):
        return self.agent_list, self.metas

    def unreachable_hosts(self):
        return dict(self.unreachable)

    def remote_targets(self):
        return list(self.targets)

    def evidence(self):
        return dict(self.evidence_data)

    def permissions(self):
        return self.perms

    def open_reviews(self, live_ids):
        return {}

    def error_line(self, agent_id):
        return self.error_lines.get(agent_id)

    def teams(self):
        return {"TUC"}

    def ticket_states(self, identifiers):
        return {i: self.states.get(i, "started") for i in identifiers}

    def running_locks(self):
        return set(self.locks)

    def decision_candidates(self):
        if self.candidates_error:
            raise self.candidates_error
        return list(self.candidates)

    def owner_url(self):
        return "https://linear.app/tuchel/profiles/mirko"

    def publish(self, document, content):
        if self.publish_error:
            raise self.publish_error
        self.published.append(content)
        return document or {"id": "doc1", "url": "https://linear.app/doc1", "documentContentId": "dc1"}

    def comment(self, auth, document, body):
        if self.comment_error:
            raise self.comment_error
        self.comments.append((auth, document["documentContentId"], body))

    def desktop(self, text):
        self.desktops.append(text)

    def app_auth(self, now):
        return self.auth


class RunCase(unittest.TestCase):
    """A temp dir holding the state, lock, log, history files and trend.json of each run."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = os.path.join(self.tmp.name, "state.json")
        self.lock = os.path.join(self.tmp.name, "lock")
        self.history = os.path.join(self.tmp.name, "history")
        self.trend = os.path.join(self.tmp.name, "trend.json")
        self._log = digest.LOG
        digest.LOG = os.path.join(self.tmp.name, "ops-digest.log")
        self.io = FakeIO()

    def tearDown(self):
        digest.LOG = self._log
        self.tmp.cleanup()

    def run_at(self, now, mode="publish"):
        return digest.run(self.io, now=now, mode=mode, state_path=self.state, lock_path=self.lock,
                          history_dir=self.history, trend_path=self.trend)

    def saved(self):
        with open(self.state) as f:
            return json.load(f)


class DigestRunTest(RunCase):
    def test_scheduled_run_starts_quarantine_job_and_a_failed_start_never_stops_it(self):
        self.io.repo_items = [deploy_item("batch-service")]
        self.io.dispatch_error = subprocess.CalledProcessError(1, ["gh"])
        self.assertEqual(self.run_at(WED_10_05), 0)
        self.assertEqual(self.io.dispatches, 1)
        self.assertEqual(len(self.io.comments), 1)
        with open(digest.LOG) as f:
            self.assertIn("flaky-quarantine.yml not dispatched", f.read())

    def test_print_and_dry_run_do_not_start_quarantine_job(self):
        self.run_at(WED_10_05, mode="print")
        self.run_at(WED_10_05, mode="dry-run")
        self.assertEqual(self.io.dispatches, 0)

    def test_unchanged_run_posts_no_second_comment(self):
        self.io.repo_items = [deploy_item("batch-service")]
        self.assertEqual(self.run_at(WED_10_05), 0)
        self.assertEqual(self.run_at(WED_11_05), 0)
        self.assertEqual(len(self.io.comments), 1)
        self.assertEqual(len(self.io.published), 2)
        auth, content_id, body = self.io.comments[0]
        self.assertEqual((auth, content_id), ("Bearer app", "dc1"))
        self.assertIn("https://linear.app/tuchel/profiles/mirko", body)
        self.assertIn("production batch-service", body)
        self.assertEqual(self.saved()["pending"], {})

    def test_failed_comment_keeps_items_pending_and_retries_next_run(self):
        self.io.repo_items = [deploy_item("batch-service")]
        self.io.comment_error = digest.LinearError("boom")
        self.run_at(WED_10_05)
        self.assertEqual(self.io.comments, [])
        self.assertEqual(list(self.saved()["pending"]), ["deploy:production/batch-service:d1:failed"])
        self.assertEqual(len(self.io.desktops), 1)
        self.run_at(WED_11_05)  # same pending set: no second desktop notification
        self.assertEqual(len(self.io.desktops), 1)
        self.assertIn("Notification pending", self.io.published[-1])
        self.io.comment_error = None
        self.run_at(at("2026-09-30T10:05:00Z"))
        self.assertEqual(len(self.io.comments), 1)
        self.assertIn("production batch-service", self.io.comments[0][2])
        self.assertEqual(self.saved()["pending"], {})

    def test_large_backlog_notification_stays_small_and_is_delivered(self):
        # 2026-10-05: 793 items piled up over a weekend; one comment with every item was too
        # large to post, so pending only grew (1241 items, a 216 KB body) and nothing arrived.
        self.io.repo_items = [pr_item(n, "draft") for n in range(1000, 1600)]
        self.run_at(TUE_23_00)
        self.io.repo_items = [pr_item(n, "draft") for n in range(1000, 1300)]
        self.run_at(WED_10_05)
        self.assertEqual(len(self.io.comments), 1)
        body = self.io.comments[0][2]
        self.assertLessEqual(len(body), digest.NOTIFY_MAX_CHARS)
        self.assertIn("Ops digest: 600 new", body)
        self.assertIn("300 / 300 — pulls: failed: ci / Lint", body)
        self.assertIn("#1299:", body)  # newest still open is listed
        self.assertNotIn("#1000:", body)
        self.assertEqual(self.saved()["pending"], {})

    def test_unreachable_remote_keeps_only_its_items_and_holds_lock_judgement(self):
        local_agent = {"id": "aaaaaaa111", "name": "TUC-301 work", "status": "error", "cwd": "/tmp"}
        mac_agent = {"id": "bbbbbbb222", "name": "TUC-302 work", "status": "error", "cwd": "/tmp", "_host": "mac"}
        self.io.agent_list = [local_agent, mac_agent]
        self.run_at(WED_10_05)
        self.assertEqual(set(self.saved()["items"]), {"agent-error:aaaaaaa111", "agent-error:bbbbbbb222"})
        # The Mac sleeps; the local agent recovered; a lock has no visible agent.
        self.io.agent_list = []
        self.io.unreachable = {"mac": "timeout"}
        self.io.locks = {"TUC-302"}
        self.run_at(WED_11_05)
        items = self.saved()["items"]
        self.assertEqual(set(items), {"agent-error:bbbbbbb222"})
        self.assertTrue(items["agent-error:bbbbbbb222"]["stale"])
        self.assertIn("agents@mac: timeout", self.io.published[-1])

    def test_unusable_app_token_falls_back_to_desktop_once(self):
        self.io.repo_items = [deploy_item("batch-service")]
        self.io.auth = None
        self.run_at(WED_10_05)
        self.run_at(WED_11_05)
        self.assertEqual(self.io.comments, [])
        self.assertEqual(len(self.io.desktops), 1)
        self.io.repo_items.append(deploy_item("core-web", "staging", "d2"))
        self.run_at(at("2026-09-30T10:05:00Z"))  # pending set changed: one more desktop hint
        self.assertEqual(len(self.io.desktops), 2)
        self.assertEqual(len(self.saved()["pending"]), 2)

    def test_item_seen_while_publishing_failed_is_still_delivered_after_it_cleared(self):
        self.io.repo_items = [deploy_item("batch-service")]
        self.io.publish_error = digest.LinearError("down")
        self.assertEqual(self.run_at(WED_09_05), 1)
        self.assertEqual(self.io.comments, [])
        self.assertIn("deploy:production/batch-service:d1:failed", self.saved()["pending"])
        self.io.publish_error = None
        self.io.repo_items = []
        self.assertEqual(self.run_at(WED_10_05), 0)
        self.assertEqual(len(self.io.comments), 1)
        body = self.io.comments[0][2]
        self.assertIn("(seen 09:05, cleared 10:05) production batch-service", body)
        self.assertIn("## Cleared since last update", self.io.published[-1])

    def test_overnight_item_is_reported_once_at_the_first_window_run(self):
        self.io.repo_items = [deploy_item("batch-service")]
        self.run_at(TUE_23_00)
        self.io.repo_items = []
        self.run_at(WED_03_00)
        self.assertEqual(self.io.comments, [])
        self.run_at(WED_08_05)
        self.assertEqual(len(self.io.comments), 1)
        self.assertIn("(seen 23:00, cleared 03:00)", self.io.comments[0][2])
        self.run_at(WED_09_05)
        self.assertEqual(len(self.io.comments), 1)

    def test_one_unreadable_service_keeps_its_item_and_others_refresh(self):
        self.io.repo_items = [deploy_item("batch-service"), deploy_item("core-web", "staging", "d2")]
        self.run_at(WED_10_05)
        self.io.repo_items = []
        self.io.repo_units = [{"unit": "deploy:production/batch-service", "ok": False, "category": "timeout"},
                              {"unit": "deploy:staging/core-web", "ok": True}]
        self.run_at(WED_11_05)
        state = self.saved()
        self.assertEqual(list(state["items"]), ["deploy:production/batch-service:d1:failed"])
        self.assertTrue(state["items"]["deploy:production/batch-service:d1:failed"]["stale"])
        doc = self.io.published[-1]
        self.assertIn("not refreshed since 10:05", doc)
        self.assertIn("deploy:production/batch-service: timeout (previous items kept)", doc)
        self.assertIn("## Cleared since last update", doc)
        self.assertIn("staging core-web", doc.split("## Cleared since last update")[1])

    def test_unread_pull_request_keeps_its_item_and_others_clear(self):
        self.io.repo_items = [pr_item(917), pr_item(918)]
        self.run_at(WED_10_05)
        self.io.repo_items = []
        self.io.repo_units = [{"unit": "pulls", "ok": True},
                              {"unit": "pulls/917", "ok": False, "category": "HTTP 502"}]
        self.run_at(WED_11_05)
        state = self.saved()
        self.assertEqual(list(state["items"]), ["pr:917:check-failed"])
        self.assertEqual([c["payload"]["key"] for c in state["cleared"]], ["pr:918:check-failed"])
        self.io.repo_units = [{"unit": "pulls", "ok": False, "category": "timeout"}]
        self.run_at(at("2026-09-30T10:05:00Z"))  # the whole PR list failed: #917 still kept
        self.assertTrue(self.saved()["items"]["pr:917:check-failed"]["stale"])

    def test_unreadable_repository_keeps_every_repository_item(self):
        self.io.repo_items = [deploy_item("batch-service")]
        self.run_at(WED_10_05)
        self.io.repo_error = TimeoutError()
        self.run_at(WED_11_05)
        state = self.saved()
        self.assertTrue(state["items"]["deploy:production/batch-service:d1:failed"]["stale"])
        self.assertIn("- repo: timeout (previous items kept)", self.io.published[-1])
        self.assertEqual(len(self.io.comments), 1)

    def test_agent_error_text_never_reaches_linear(self):
        agent = {"id": "abcdef1234567890", "name": "TUC-372: ops digest", "status": "error", "cwd": "/tmp"}
        self.io.agent_list = [agent]
        self.io.error_lines = {agent["id"]: "Error: 401 Unauthorized token=lin_api_SECRET123"}
        self.run_at(WED_10_05)
        published = self.io.published[-1] + self.io.comments[0][2]
        self.assertNotIn("SECRET123", published)
        self.assertIn("agent abcdef1 \"TUC-372: ops digest\" TUC-372: in error: other error", published)
        self.assertIn("`paseo logs abcdef1 --tail 5`", published)

    def test_silent_ticket_agent_and_orphaned_lock(self):
        agent = {"id": "1234567abc", "name": "TUC-300 work", "status": "idle", "cwd": "/tmp"}
        self.io.agent_list = [agent]
        self.io.metas = {agent["id"]: {"lastActivityAt": "2026-09-30T05:00:00Z"}}
        self.io.locks = {"TUC-300", "TUC-301"}
        self.run_at(WED_10_05)
        keys = set(self.saved()["items"])
        self.assertEqual(keys, {"agent-silent:1234567abc", "lock-orphan:TUC-301"})
        self.io.states = {"TUC-300": "completed"}
        self.io.locks = set()
        self.run_at(WED_11_05)
        self.assertEqual(self.saved()["items"], {})

    def test_print_and_dry_run_write_no_state(self):
        self.io.repo_items = [deploy_item("batch-service")]
        self.assertEqual(self.run_at(WED_10_05, mode="dry-run"), 0)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(self.run_at(WED_10_05, mode="print"), 0)
        self.assertIn("**new** production batch-service: FAILED", out.getvalue())
        self.assertFalse(os.path.exists(self.state))
        self.assertEqual((self.io.published, self.io.comments), ([], []))

    def test_second_run_exits_while_the_lock_is_held(self):
        with open(self.lock, "w") as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.run_at(WED_10_05), 75)
        self.assertEqual(self.io.published, [])

    def test_decision_candidates_count_waiting_proposals_without_attention(self):
        self.io.candidates = [candidates_ticket(760, [1, 2, 3], ["**Q-2 answered** — approved: yes"])]
        self.run_at(WED_10_05)
        decisions = self.saved()["decisionCandidates"]
        self.assertEqual(decisions["waiting"], 2)
        self.assertFalse(decisions["stale"])
        self.assertIn("- Decision candidates waiting: 2 — [TUC-760](https://linear.app/tuchel/issue/TUC-760) (2)",
                      self.io.published[-1])
        self.assertEqual((self.saved()["pending"], self.io.comments, self.io.desktops), ({}, [], []))

    def test_decision_candidates_failed_read_keeps_previous_value(self):
        self.io.candidates = [candidates_ticket(760, [1, 2, 3], ["**Q-2 answered** — approved: yes"])]
        self.run_at(WED_10_05)
        self.io.candidates_error = digest.LinearError("down")
        self.run_at(WED_11_05)
        decisions = self.saved()["decisionCandidates"]
        self.assertEqual((decisions["waiting"], decisions["stale"]), (2, True))
        doc = self.io.published[-1]
        self.assertIn("Decision candidates waiting: 2 — [TUC-760]", doc)
        self.assertIn("_(not refreshed since 10:05)_", doc)
        self.assertIn("- decision_candidates: error (previous items kept)", doc)
        self.assertEqual(self.io.comments, [])

    def test_decision_candidates_line_rendered_when_nothing_waits(self):
        self.io.candidates = [candidates_ticket(761, [4], ["**Q-4 answered** — approved: yes"])]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.run_at(WED_10_05, mode="print")
        self.assertIn("- Decision candidates waiting: 0\n", out.getvalue())
        self.assertNotIn("TUC-761", out.getvalue())


class WindowTest(unittest.TestCase):
    def test_window_is_weekdays_08_to_19_berlin(self):
        self.assertFalse(digest.in_window(at("2026-09-30T05:59:00Z")))  # 07:59
        self.assertTrue(digest.in_window(WED_08_05))
        self.assertTrue(digest.in_window(at("2026-09-30T16:59:00Z")))  # 18:59
        self.assertFalse(digest.in_window(at("2026-09-30T17:00:00Z")))  # 19:00
        self.assertFalse(digest.in_window(at("2026-10-03T08:05:00Z")))  # Saturday


class DecisionCandidatesTest(unittest.TestCase):
    def test_answered_proposal_is_not_waiting(self):
        result = digest.decision_candidates([candidates_ticket(760, [1, 2, 3], ["**Q-2 answered** — approved: yes"])])
        self.assertEqual(result, {"waiting": 2, "tickets": [
            {"identifier": "TUC-760", "url": "https://linear.app/tuchel/issue/TUC-760", "waiting": 2}]})

    def test_open_ticket_with_every_proposal_answered_waits_for_nothing(self):
        ticket = candidates_ticket(761, [1, 2], ["**Q-1 answered** — approved: yes",
                                                 "**Q-2 answered** — changed: only for ERP"])
        self.assertEqual(digest.decision_candidates([ticket]), {"waiting": 0, "tickets": []})

    def test_rejection_counts_as_answered(self):
        ticket = candidates_ticket(762, [5, 6], ["**Q-5 answered** — rejected: one-off"])
        self.assertEqual(digest.decision_candidates([ticket])["waiting"], 1)

    def test_tickets_without_marker_are_ignored_and_counts_sum(self):
        stray = {**candidates_ticket(763, [1]), "description": "mentions decision-candidates in passing\n## Q-1 — x"}
        result = digest.decision_candidates([candidates_ticket(765, [1]), stray, candidates_ticket(764, [7, 8])])
        self.assertEqual(result["waiting"], 3)
        self.assertEqual([t["identifier"] for t in result["tickets"]], ["TUC-764", "TUC-765"])

    def test_agent_tooling_and_later_run_tickets_are_counted(self):
        tooling = candidates_ticket(766, [2], project="Agent tooling")
        rerun = candidates_ticket(767, [3], week="2026-W41 run 2")
        self.assertEqual(digest.decision_candidates([tooling, rerun])["waiting"], 2)

    def test_render_shows_the_line(self):
        state = digest.empty_state()
        state["decisionCandidates"] = {"waiting": 1, "at": WED_10_05, "stale": False, "tickets": [
            {"identifier": "TUC-760", "url": "https://linear.app/tuchel/issue/TUC-760", "waiting": 1}]}
        out = digest.render(state, [], WED_10_05)
        self.assertIn("## Decision candidates\n\n- Decision candidates waiting: 1 — "
                      "[TUC-760](https://linear.app/tuchel/issue/TUC-760) (1)\n", out)
        self.assertEqual(digest.pending_signature(state), "")


ITEM_FIELDS = {"t", "event", "key", "kind", "unit", "first", "attention", "section", "group", "ticket", "host",
               "stale", "owner", "auto"}
OCT_01_08_05 = at("2026-10-01T06:05:00Z")


def read_lines(path):
    with open(path) as f:
        return [json.loads(text) for text in f]


def lock_item(ident="TUC-301"):
    return {"key": f"lock-orphan:{ident}", "unit": "locks", "section": "agents", "group": "locks", "attention": True,
            "title": ident, "ticket": None, "detail": "labelled as having a running agent, but no agent works on it",
            "command": None}


class HistoryRunTest(RunCase):
    def lines(self, name="history.jsonl"):
        return read_lines(os.path.join(self.history, name))

    def test_runs_and_items_are_recorded_without_free_text(self):  # AC-1
        agent = {"id": "abcdef1234567890", "name": "TUC-372: ops digest", "status": "error", "cwd": "/tmp"}
        agent_key = "agent-error:abcdef1234567890"
        self.io.agent_list = [agent]
        self.io.error_lines = {agent["id"]: "Error: 401 Unauthorized token=lin_api_SECRET123"}
        a, b, d = deploy_item("batch-service"), pr_item(918), deploy_item("core-web", "staging", "d2")
        self.io.repo_items = [a, b, d]
        self.assertEqual(self.run_at(WED_10_05), 0)
        c = pr_item(919)
        self.io.repo_items = [a, c]
        self.io.repo_units = [{"unit": "main", "ok": True},
                              {"unit": "deploy:staging/core-web", "ok": False, "category": "timeout"}]
        self.assertEqual(self.run_at(WED_11_05), 0)
        with open(os.path.join(self.history, "history.jsonl")) as f:
            text = f.read()
        self.assertNotIn("SECRET123", text)
        lines = [json.loads(t) for t in text.splitlines()]
        runs = [i for i, line in enumerate(lines) if line["event"] == "run"]
        self.assertEqual(runs, [0, 5])
        first, second = lines[0:5], lines[5:]
        self.assertEqual(first[0]["units"]["repo"], True)
        self.assertEqual(second[0]["units"]["deploy:staging/core-web"], False)
        self.assertEqual(second[0]["units"]["pulls/919"], True)
        self.assertNotIn("pulls/918", second[0]["units"])
        self.assertEqual((second[0]["t"], second[0]["host"], second[0]["hosts"], second[0]["items"]),
                         ("2026-09-30T09:05:00Z", digest.HOST_NAME, [digest.HOST_NAME], 4))
        self.assertEqual({(line["event"], line["key"]) for line in first[1:]},
                         {("opened", a["key"]), ("opened", b["key"]), ("opened", d["key"]), ("opened", agent_key)})
        self.assertEqual({(line["event"], line["key"], line["stale"]) for line in second[1:]},
                         {("open", a["key"], False), ("cleared", b["key"], False), ("opened", c["key"], False),
                          ("open", d["key"], True), ("open", agent_key, False)})
        for line in first[1:] + second[1:]:
            self.assertEqual(set(line), ITEM_FIELDS)
        by_key = {line["key"]: line for line in second[1:]}
        self.assertEqual((by_key[c["key"]]["kind"], by_key[c["key"]]["group"], by_key[c["key"]]["host"]),
                         ("pulls: failed: ci / Lint", 919, None))
        self.assertEqual((by_key[a["key"]]["kind"], by_key[a["key"]]["first"]), ("deploys: FAILED", "2026-09-30T08:05:00Z"))
        self.assertEqual((by_key[agent_key]["ticket"], by_key[agent_key]["host"], by_key[agent_key]["kind"]),
                         ("TUC-372", digest.HOST_NAME, "agents: in error: other error"))
        self.assertEqual(self.saved()["historyOutbox"], [])

    def test_run_line_names_every_host_read(self):
        self.io.targets = ["mac", "mini"]
        self.io.unreachable = {"mini": "timeout"}
        self.run_at(WED_10_05)
        run = self.lines()[0]
        self.assertEqual(run["hosts"], sorted([digest.HOST_NAME, "mac"]))
        self.assertEqual({u: run["units"][u] for u in ("agents@mac", "silent@mac", "agents@mini", "silent@mini", "repo")},
                         {"agents@mac": True, "silent@mac": True, "agents@mini": False, "silent@mini": False, "repo": True})
        self.assertNotIn("agents@mac", self.io.published[-1])  # only failed units are listed

        def broken():
            raise subprocess.CalledProcessError(1, ["paseo"])
        self.io.agents = broken
        self.run_at(WED_11_05)
        run = [line for line in self.lines() if line["event"] == "run"][-1]
        self.assertEqual(run["hosts"], [])
        self.assertEqual((run["units"]["agents@mac"], run["units"]["silent@mac"], run["units"]["agents"]), (False, False, False))

    def test_print_and_dry_run_write_no_history(self):
        self.io.repo_items = [deploy_item("batch-service")]
        with contextlib.redirect_stdout(io.StringIO()):
            self.run_at(WED_10_05, mode="print")
        self.run_at(WED_10_05, mode="dry-run")
        self.assertFalse(os.path.exists(self.history))
        self.assertFalse(os.path.exists(self.state))

    def test_month_change_moves_history_into_its_month_file(self):  # AC-2
        os.makedirs(self.history)
        with open(os.path.join(self.history, "history.jsonl"), "wb") as f:
            f.write(digest.encode_line({"t": "2026-09-30T20:05:00Z", "event": "run"})
                    + digest.encode_line({"t": "2026-09-30T21:05:00Z", "event": "run"}))
        with open(os.path.join(self.history, "history-2026-09.jsonl"), "wb") as f:
            f.write(digest.encode_line({"t": "2026-09-01T00:05:00Z", "event": "run"}))
        self.io.repo_items = [deploy_item("batch-service")]
        self.assertEqual(self.run_at(OCT_01_08_05), 0)
        self.assertEqual([line["t"] for line in self.lines("history-2026-09.jsonl")],
                         ["2026-09-01T00:05:00Z", "2026-09-30T20:05:00Z", "2026-09-30T21:05:00Z"])
        october = self.lines()
        self.assertEqual([line["event"] for line in october], ["run", "opened"])
        self.assertTrue(all(line["t"].startswith("2026-10") for line in october))

    def test_outbox_spanning_month_end_writes_each_line_to_its_month(self):  # AC-2
        state = {"historyOutbox": [[{"t": "2026-09-30T21:05:00Z", "event": "run"}],
                                   [{"t": "2026-10-01T06:05:00Z", "event": "run"}]]}
        digest.flush_history(state, self.history, OCT_01_08_05)
        self.assertEqual(state["historyOutbox"], [])
        self.assertEqual([line["t"] for line in self.lines("history-2026-09.jsonl")], ["2026-09-30T21:05:00Z"])
        self.assertEqual([line["t"] for line in self.lines()], ["2026-10-01T06:05:00Z"])

    def test_failed_append_keeps_the_outbox_and_the_next_run_writes_both_once(self):  # AC-6
        with open(self.history, "w") as f:
            f.write("a file where the history directory should be")
        item = deploy_item("batch-service")
        self.io.repo_items = [item]
        self.assertEqual(self.run_at(WED_10_05), 0)
        self.assertEqual(len(self.saved()["historyOutbox"]), 1)
        self.assertEqual(len(self.io.published), 1)
        with open(digest.LOG) as f:
            self.assertIn("WARN history not written (", f.read())
        os.remove(self.history)
        self.assertEqual(self.run_at(WED_11_05), 0)
        lines = self.lines()
        self.assertEqual([(line["event"], line["t"]) for line in lines if line["event"] == "run"],
                         [("run", "2026-09-30T08:05:00Z"), ("run", "2026-09-30T09:05:00Z")])
        self.assertEqual([(line["event"], line["key"]) for line in lines if line["event"] != "run"],
                         [("opened", item["key"]), ("open", item["key"])])
        self.assertEqual(self.saved()["historyOutbox"], [])

    def test_torn_line_is_cut_and_its_record_written_once(self):  # AC-6
        self.io.repo_items = [deploy_item("batch-service"), deploy_item("core-web", "staging", "d2")]
        self.run_at(WED_09_05)
        path = os.path.join(self.history, "history.jsonl")
        real = digest.append_history

        def torn(target, encoded):
            with open(target, "ab") as f:
                f.write(encoded[0] + encoded[1][:20])
            raise OSError("disk full")
        digest.append_history = torn
        try:
            self.assertEqual(self.run_at(WED_10_05), 0)
        finally:
            digest.append_history = real
        with open(path, "rb") as f:
            self.assertFalse(f.read().endswith(b"\n"))
        self.assertEqual(len(self.saved()["historyOutbox"]), 1)
        self.assertEqual(self.run_at(WED_11_05), 0)
        with open(path) as f:
            raw = f.read()
        lines = [json.loads(t) for t in raw.splitlines()]  # every line is complete
        ids = [(line["t"], line["event"], line.get("key")) for line in lines]
        self.assertEqual(len(ids), 9)  # 3 runs: a run line and 2 items each
        self.assertEqual(len(set(ids)), 9)
        self.assertEqual([line["t"] for line in lines if line["event"] == "run"],
                         ["2026-09-30T07:05:00Z", "2026-09-30T08:05:00Z", "2026-09-30T09:05:00Z"])

    def test_more_than_72_waiting_runs_become_one_gap_line(self):  # AC-6
        base = at("2026-10-05T08:05:00Z")
        iso = digest.iso
        outbox = [[{"t": iso(base + i * 3600), "event": "run"}, {"t": iso(base + i * 3600), "event": "open", "key": "k"}]
                  for i in range(75)]
        capped = digest.cap_outbox(outbox)
        self.assertEqual(len(capped), 73)
        self.assertEqual(capped[0], [{"t": iso(base), "event": "gap", "from": iso(base), "to": iso(base + 2 * 3600)}])
        self.assertEqual(capped[1:], outbox[3:])
        again = digest.cap_outbox(capped + [[{"t": iso(base + 75 * 3600), "event": "run"}]])
        self.assertEqual(len(again), 73)
        self.assertEqual(again[0], [{"t": iso(base), "event": "gap", "from": iso(base), "to": iso(base + 3 * 3600)}])
        state = {"historyOutbox": again}
        digest.flush_history(state, self.history, base + 80 * 3600)
        lines = self.lines()
        self.assertEqual([line["event"] for line in lines].count("gap"), 1)
        self.assertEqual(lines[0], {"t": iso(base), "event": "gap", "from": iso(base), "to": iso(base + 3 * 3600)})
        self.assertEqual(lines[1]["t"], iso(base + 4 * 3600))
        self.assertEqual(len(lines), 1 + 71 * 2 + 1)


class ItemKindTest(unittest.TestCase):
    def kind(self, detail, section="pulls"):
        return digest.item_kind({"section": section, "detail": detail})

    def test_numbers_and_parenthesised_specifics_give_one_kind(self):  # AC-4
        pairs = [("base branch graphite-base/1411 has no open PR: re-open onto main",
                  "base branch graphite-base/2090 has no open PR: re-open onto main"),
                 ("2 unresolved review threads", "13 unresolved review threads"),
                 ("green; waits for #12 (x (y))", "green; waits for #7 (z)")]
        for left, right in pairs:
            self.assertEqual(self.kind(left), self.kind(right))
        self.assertEqual(self.kind(pairs[0][0]), "pulls: base branch graphite-base/N has no open PR: re-open onto main")
        self.assertEqual(self.kind(pairs[2][0]), "pulls: green; waits for #N")
        self.assertEqual(self.kind("running, no activity for 3 h", "agents"), "agents: running, no activity for N h")
        self.assertEqual(self.kind("running, no activity for 45 min", "agents"), "agents: running, no activity for N min")
        self.assertEqual(self.kind("draft, not published (since 2026-10-01)"), "pulls: draft, not published")
        self.assertEqual(self.kind("waits for your permission: OMP select", "agents"),
                         "agents: waits for your permission: OMP select")
        self.assertEqual(self.kind("unbalanced ) and ( parens"), "pulls: unbalanced and parens")

    def test_greptile_re_request_suffix_keeps_the_kind(self):  # TUC-1208 AC-6
        self.assertEqual(self.kind("complex-review: no Greptile review yet (Greptile re-requested 14:05)"),
                         "pulls: complex-review: no Greptile review yet")
        self.assertEqual(self.kind("complex-review: no Greptile review yet"), "pulls: complex-review: no Greptile review yet")


class BackfillTest(unittest.TestCase):
    NOW = at("2026-10-07T09:00:00Z")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = os.path.join(self.tmp.name, "state.json")
        self.lock = os.path.join(self.tmp.name, "lock")
        self.history = os.path.join(self.tmp.name, "history")
        deploy = deploy_item("batch-service")
        state = {**digest.empty_state(),
                 "items": {"pr:917:draft": {"payload": pr_item(917, "draft"), "firstSeen": WED_08_05,
                                            "lastSeen": WED_10_05, "stale": False}},
                 "pending": {deploy["key"]: {"payload": deploy, "firstSeen": WED_09_05, "clearedAt": WED_10_05}},
                 "cleared": [{"payload": deploy, "firstSeen": WED_09_05, "lastSeen": WED_09_05, "stale": False,
                              "clearedAt": WED_10_05},
                             {"payload": lock_item(), "firstSeen": WED_08_05, "lastSeen": WED_08_05, "stale": False,
                              "clearedAt": WED_09_05}]}
        with open(self.state, "w") as f:
            json.dump(state, f)
        with open(self.state, "rb") as f:
            self.state_bytes = f.read()

    def tearDown(self):
        self.tmp.cleanup()

    def backfill(self):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return digest.backfill_history(self.state, self.history, self.lock, self.NOW)

    def test_backfill_writes_opened_and_cleared_lines_once(self):  # AC-5
        self.assertEqual(self.backfill(), 0)
        lines = read_lines(os.path.join(self.history, "history-backfill.jsonl"))
        deploy_key = deploy_item("batch-service")["key"]
        self.assertEqual([(line["t"], line["event"], line["key"]) for line in lines], [
            ("2026-09-30T06:05:00Z", "opened", "lock-orphan:TUC-301"),
            ("2026-09-30T06:05:00Z", "opened", "pr:917:draft"),
            ("2026-09-30T07:05:00Z", "opened", deploy_key),
            ("2026-09-30T07:05:00Z", "cleared", "lock-orphan:TUC-301"),
            ("2026-09-30T08:05:00Z", "cleared", deploy_key)])
        for line in lines:
            self.assertEqual(set(line), ITEM_FIELDS | {"src"})
            self.assertEqual((line["src"], line["owner"], line["auto"], line["stale"]), ("backfill", None, None, False))
        self.assertEqual(lines[1]["kind"], "pulls: failed: ci / Lint")
        with open(f"{self.state}.bak-20261007-backfill", "rb") as f:
            self.assertEqual(f.read(), self.state_bytes)
        with open(self.state, "rb") as f:
            self.assertEqual(f.read(), self.state_bytes)
        self.assertEqual(self.backfill(), 1)  # ran already: refused
        self.assertEqual(read_lines(os.path.join(self.history, "history-backfill.jsonl")), lines)

    def test_failure_before_the_rename_leaves_no_file(self):  # AC-5
        with mock.patch.object(digest.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.backfill()
        self.assertEqual(os.listdir(self.history), [])

    def test_held_lock_exits_75(self):  # AC-5
        with open(self.lock, "w") as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.backfill(), 75)
        self.assertFalse(os.path.exists(self.history))


TREND = {"week": "2026-W41", "generatedAt": "2026-10-12T05:31:00Z",
         "window": {"this": {"from": "2026-10-05T05:31:00Z", "to": "2026-10-12T05:31:00Z"},
                    "last": {"from": "2026-09-28T05:31:00Z", "to": "2026-10-05T05:31:00Z"}},
         "headline": {
             "this": {"ownerTrue": 12, "mergedPrs": 29, "ownerPerMergedPr": 0.4138, "clearedWithoutOwner": 19,
                      "clearedKnownOwner": 30, "clearedUnknownOwner": 4, "shareClearedWithoutOwner": 0.6333,
                      "medianHoursToClear": 3.1, "complete": True},
             "last": {"ownerTrue": 10, "mergedPrs": None, "ownerPerMergedPr": None, "clearedWithoutOwner": 11,
                      "clearedKnownOwner": 20, "clearedUnknownOwner": 2, "shareClearedWithoutOwner": 0.55,
                      "medianHoursToClear": 4.0, "complete": False}},
         "kinds": [{"kind": "pulls: draft, not published", "thisWeek": 12, "lastWeek": 8, "complete": True},
                   {"kind": "agents: in error: rate limit", "thisWeek": 5, "lastWeek": 0, "complete": False}]}


class TrendTest(RunCase):
    def test_render_shows_headline_and_top_kinds(self):  # AC-13
        state = digest.empty_state()
        state["cleared"] = [{"payload": deploy_item("batch-service"), "firstSeen": WED_09_05, "clearedAt": WED_10_05}]
        out = digest.render(state, [], WED_10_05, trend=TREND)
        self.assertIn("## Trend (week to 12.10.2026)\n\n"
                      "- Problems that needed you per merged PR (observed owner involvement): 0.41 (12 of 29 merged PRs)"
                      " — last week unknown (10 of unknown merged PRs) _(not enough data)_\n"
                      "- Share of problems cleared without you: 63 % (19 of 30 with known owner, 4 unknown)"
                      " — last week 55 % (11 of 20 with known owner, 2 unknown) _(not enough data)_\n"
                      "- Median time to clear: 3.1 h — last week 4.0 h _(not enough data)_\n"
                      "- Top kinds this week vs last week:\n"
                      "  - pulls: draft, not published: 12 vs 8\n"
                      "  - agents: in error: rate limit: 5 vs 0 _(not enough data)_\n", out)
        self.assertLess(out.index("## Decision candidates"), out.index("## Trend"))
        self.assertLess(out.index("## Trend"), out.index("## Cleared since last update"))

    def test_render_without_trend_says_not_computed_yet(self):  # AC-13
        out = digest.render(digest.empty_state(), [], WED_10_05)
        self.assertIn("## Trend\n\n- Trend: not computed yet\n", out)

    def test_run_publishes_the_trend_and_survives_a_bad_file(self):  # AC-13
        with open(self.trend, "w") as f:
            json.dump(TREND, f)
        self.run_at(WED_10_05)
        self.assertIn("## Trend (week to 12.10.2026)", self.io.published[-1])
        for bad in ("{not json", json.dumps({"week": "2026-W41"})):
            with open(self.trend, "w") as f:
                f.write(bad)
            self.assertEqual(self.run_at(WED_11_05), 0)
            self.assertIn("- Trend: not computed yet", self.io.published[-1])
        with open(digest.LOG) as f:
            self.assertEqual(f.read().count("WARN trend.json unreadable (unreadable response)"), 2)
        os.remove(self.trend)
        self.assertIsNone(digest.load_trend(self.trend))


def agent_payload(key, unit, group):
    return {"key": key, "unit": unit, "section": "agents", "group": group, "attention": True,
            "title": "agent x \"secret plan\"", "detail": "in error: other error", "ticket": "TUC-1"}


class EvidenceTest(unittest.TestCase):
    def events(self, evidence, units=({"unit": "agents", "ok": True},)):
        payloads = [agent_payload("agent-error:r1", "agents@mirko@x", "error"),
                    agent_payload("agent-waiting:r2:p1", "agents@mirko@x", "waiting"),
                    agent_payload("agent-error:l1", "agents", "error"),
                    agent_payload("agent-waiting:l2:2026-10-01T10:00:00Z", "agents", "waiting"),
                    pr_item(917, "draft"), pr_item(918, "draft"), lock_item()]
        merged = {"items": {p["key"]: {"payload": p, "firstSeen": WED_09_05, "lastSeen": WED_10_05, "stale": False}
                            for p in payloads}}
        return digest.history_events({}, merged, list(units), WED_10_05, host=digest.HOST_NAME,
                                     read_hosts=[digest.HOST_NAME], evidence=evidence)

    def test_owner_and_auto_come_from_the_records_at_this_run(self):  # AC-19
        lines = self.events({"prWatch": {digest.PULL_URL.format(917): {"nudges": {"draft": ["abc"]}, "escalated": False}},
                             "crashes": {"l1": {"restarts": 2, "escalated": True, "error": "crash SECRET456"}}})
        self.assertEqual({line["key"]: (line["owner"], line["auto"]) for line in lines[1:]}, {
            "agent-error:r1": (None, None), "agent-waiting:r2:p1": (True, None), "agent-error:l1": (True, True),
            "agent-waiting:l2:2026-10-01T10:00:00Z": (True, False), "pr:917:draft": (False, True),
            "pr:918:draft": (False, False), "lock-orphan:TUC-301": (None, None)})
        hosts = {line["key"]: line["host"] for line in lines[1:]}
        self.assertEqual((hosts["agent-error:r1"], hosts["agent-waiting:r2:p1"], hosts["agent-error:l1"], hosts["pr:917:draft"]),
                         ("mirko@x", "mirko@x", digest.HOST_NAME, None))
        self.assertNotIn("SECRET456", json.dumps(lines))
        self.assertNotIn("secret plan", json.dumps(lines))

    def test_unreadable_records_give_unknown(self):  # AC-19
        lines = self.events({"prWatch": None, "crashes": None})
        self.assertEqual({line["key"]: (line["owner"], line["auto"]) for line in lines[1:]}, {
            "agent-error:r1": (None, None), "agent-waiting:r2:p1": (True, None), "agent-error:l1": (None, None),
            "agent-waiting:l2:2026-10-01T10:00:00Z": (True, None), "pr:917:draft": (None, None),
            "pr:918:draft": (None, None), "lock-orphan:TUC-301": (None, None)})

    def test_unit_listed_read_and_failed_counts_as_failed(self):
        lines = self.events({"prWatch": None, "crashes": None},
                            units=[{"unit": "pulls", "ok": True}, {"unit": "pulls", "ok": False, "category": "timeout"}])
        self.assertEqual(lines[0]["units"], {"pulls": False, "pulls/917": True, "pulls/918": True})

    def test_a_greptile_re_request_counts_as_automation(self):  # TUC-1208 AC-7
        lines = self.events({"prWatch": {digest.PULL_URL.format(917): {"greptile": [{"head": "a" * 40, "at": WED_09_05}]},
                                         digest.PULL_URL.format(918): {"greptile": []}},
                             "crashes": {}})
        found = {line["key"]: (line["owner"], line["auto"]) for line in lines[1:]}
        self.assertEqual((found["pr:917:draft"], found["pr:918:draft"]), ((False, True), (False, False)))


if __name__ == "__main__":
    unittest.main()
