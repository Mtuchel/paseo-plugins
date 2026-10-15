#!/usr/bin/env python3
"""Behavioral checks for the independent plugin recovery timer."""
import fcntl
import importlib.util
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

SOURCE = Path(__file__).with_name("paseo-plugin-recovery.py")
spec = importlib.util.spec_from_file_location("plugin_recovery", SOURCE)
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)
NOW = datetime(2026, 10, 15, 20, 0, tzinfo=timezone.utc).timestamp()


class RecoveryTests(unittest.TestCase):
    def test_local_rpc_timeout_requires_three_consecutive_samples(self):
        unavailable = {"at": datetime.fromtimestamp(NOW, timezone.utc).isoformat(), "leaseOk": False,
                       "reason": "plugin unavailable: linear.capacity timed out"}
        self.assertEqual(recovery.liveness(NOW, True, {"enabled": True, "status": "running"}, unavailable)[0], "failing")
        state = None
        for sample in (NOW, NOW + 120):
            state, eligible = recovery.next_state(state, "failing", sample)
            self.assertFalse(eligible)
        state, eligible = recovery.next_state(state, "healthy", NOW + 240)
        self.assertFalse(eligible)
        self.assertEqual(state["failures"], 0)
        for sample in (NOW + 360, NOW + 480, NOW + 600):
            state, eligible = recovery.next_state(state, "failing", sample)
        self.assertTrue(eligible)

    def test_disabled_or_stale_observation_never_restarts_daemon(self):
        self.assertEqual(recovery.liveness(NOW, True, {"enabled": False, "status": "failed"}, {})[0], "unknown")
        stale = {"at": datetime.fromtimestamp(NOW - 300, timezone.utc).isoformat(), "leaseOk": False,
                 "reason": "plugin unavailable: timeout"}
        self.assertEqual(recovery.liveness(NOW, True, {"enabled": True, "status": "running"}, stale)[0], "unknown")
        self.assertEqual(recovery.liveness(NOW, False, {"enabled": True, "status": "failed"}, stale)[0], "unknown")
        state, eligible = recovery.next_state({"failures": 4}, "unknown", NOW)
        self.assertFalse(eligible)
        self.assertEqual(state["failures"], 0)

    def test_reload_status_must_be_confirmed_by_local_rpc(self):
        failed = {"at": datetime.fromtimestamp(NOW, timezone.utc).isoformat(), "leaseOk": False,
                  "reason": "plugin unavailable: linear.capacity timed out"}
        healthy = {"at": datetime.fromtimestamp(NOW, timezone.utc).isoformat(), "leaseOk": True}
        entry = {"enabled": True, "status": "running"}
        with mock.patch.object(recovery, "read_json", return_value=failed), mock.patch.object(recovery.time, "time", return_value=NOW), mock.patch.object(recovery.time, "sleep") as sleep:
            self.assertEqual(recovery.reload_verified(entry), "failing")
            self.assertEqual(sleep.call_count, 3)
        with mock.patch.object(recovery, "read_json", side_effect=[failed, healthy]), mock.patch.object(recovery.time, "time", return_value=NOW), mock.patch.object(recovery.time, "sleep") as sleep:
            self.assertEqual(recovery.reload_verified(entry), "healthy")
            sleep.assert_called_once_with(10)

    def test_cooldown_and_daily_limit_guard_repeated_failure(self):
        state, eligible = recovery.next_state({"failures": 2, "attempts": []}, "failing", NOW)
        self.assertTrue(eligible)
        state["attempts"].append(NOW)
        state, eligible = recovery.next_state(state, "failing", NOW + 120)
        self.assertFalse(eligible)
        state, eligible = recovery.next_state(state, "failing", NOW + 3600)
        self.assertTrue(eligible)
        state["attempts"].append(NOW + 3600)
        state, eligible = recovery.next_state(state, "failing", NOW + 7200)
        self.assertFalse(eligible)
        state, eligible = recovery.next_state(state, "failing", NOW + 86401)
        self.assertTrue(eligible)

    def test_reload_failure_restarts_daemon_once_and_records_success(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            commands = []
            def command(args, timeout):
                commands.append(tuple(args))
                if args[:2] == ["systemctl", "--user"] and args[2] == "is-active":
                    return True, "active"
                return (True, "") if args[0] == "systemctl" else (False, "")
            with (mock.patch.object(recovery, "BASE", base),
                  mock.patch.object(recovery, "LOCK", base / "lock"),
                  mock.patch.object(recovery, "STATE", base / "state.json"),
                  mock.patch.object(recovery, "command", side_effect=command),
                  mock.patch.object(recovery, "plugin_status", side_effect=[{"enabled": True, "status": "failed"},
                                                                   {"enabled": True, "status": "running"}]),
                  mock.patch.object(recovery, "read_json", side_effect=lambda path: {"failures": 2, "attempts": []} if path == base / "state.json" else {}),
                  mock.patch.object(recovery.time, "time", return_value=NOW)):
                self.assertEqual(recovery.main(), 0)
            self.assertEqual(len([args for args in commands if "reload" in args]), 1)
            self.assertEqual(len([args for args in commands if "restart" in args]), 1)
            self.assertEqual(recovery.read_json(base / "state.json")["lastAction"], "daemon restarted")

    def test_live_rollout_prevents_parallel_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            with (base / "plugin-rollout.lock").open("a") as rollout:
                fcntl.flock(rollout, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with (mock.patch.object(recovery, "BASE", base),
                      mock.patch.object(recovery, "ROLLOUT_LOCK", base / "plugin-rollout.lock"),
                      mock.patch.object(recovery, "command") as command):
                    self.assertEqual(recovery.main(), 0)
                    command.assert_not_called()


if __name__ == "__main__":
    unittest.main()
