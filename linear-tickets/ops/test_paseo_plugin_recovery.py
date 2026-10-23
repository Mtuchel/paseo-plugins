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

    def clock(self):
        """A fake clock that sleeping advances, so polling windows end deterministically."""
        now = [NOW]
        def sleep(seconds):
            now[0] += seconds
        return mock.patch.object(recovery.time, "time", side_effect=lambda: now[0]), mock.patch.object(recovery.time, "sleep", side_effect=sleep)

    def observation(self, at, ok):
        stamp = datetime.fromtimestamp(at, timezone.utc).isoformat()
        return {"at": stamp, "leaseOk": True} if ok else {"at": stamp, "leaseOk": False, "reason": "plugin unavailable: linear.capacity timed out"}

    def test_verification_counts_only_observations_after_the_reload(self):
        running = {"enabled": True, "status": "running"}
        clock, sleep = self.clock()
        # A healthy observation from before the reload proves nothing: without a newer one the
        # window ends unknown, which never restarts the daemon.
        with clock, sleep, mock.patch.object(recovery, "plugin_status", return_value=running), \
             mock.patch.object(recovery, "read_json", return_value=self.observation(NOW - 5, True)):
            self.assertEqual(recovery.verified_since(NOW, 180), "unknown")
        clock, sleep = self.clock()
        # A slow plugin that fails its first fresh checks and answers within the window recovers.
        later = iter([self.observation(NOW - 5, False), self.observation(NOW + 10, False), self.observation(NOW + 20, True)])
        with clock, sleep as slept, mock.patch.object(recovery, "plugin_status", return_value=running), \
             mock.patch.object(recovery, "read_json", side_effect=lambda path: next(later)):
            self.assertEqual(recovery.verified_since(NOW, 180), "healthy")
            self.assertEqual(slept.call_count, 2)
        clock, sleep = self.clock()
        with clock, sleep, mock.patch.object(recovery, "plugin_status", return_value=running), \
             mock.patch.object(recovery, "read_json", side_effect=lambda path: self.observation(recovery.time.time(), False)):
            self.assertEqual(recovery.verified_since(NOW, 180), "failing")
            self.assertLessEqual(recovery.time.time(), NOW + 180)
        clock, sleep = self.clock()
        with clock, sleep as slept, mock.patch.object(recovery, "plugin_status", return_value={"enabled": True, "status": "failed"}):
            self.assertEqual(recovery.verified_since(NOW, 180), "failing")
            slept.assert_not_called()

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

    def run_recovery(self, verdicts):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            commands = []
            def command(args, timeout):
                commands.append(tuple(args))
                if args[:2] == ["systemctl", "--user"] and args[2] == "is-active":
                    return True, "active"
                return True, ""
            with (mock.patch.object(recovery, "BASE", base),
                  mock.patch.object(recovery, "LOCK", base / "lock"),
                  mock.patch.object(recovery, "ROLLOUT_LOCK", base / "rollout.lock"),
                  mock.patch.object(recovery, "STATE", base / "state.json"),
                  mock.patch.object(recovery, "command", side_effect=command),
                  mock.patch.object(recovery, "plugin_status", return_value={"enabled": True, "status": "failed"}),
                  mock.patch.object(recovery, "verified_since", side_effect=verdicts),
                  mock.patch.object(recovery, "read_json", side_effect=lambda path: {"failures": 2, "attempts": []} if path == base / "state.json" else {}),
                  mock.patch.object(recovery.time, "time", return_value=NOW)):
                code = recovery.main()
            reloads = len([args for args in commands if "reload" in args])
            restarts = len([args for args in commands if "restart" in args])
            return code, reloads, restarts, recovery.read_json(base / "state.json")["lastAction"]

    def test_second_reload_recovers_without_restarting_the_daemon(self):
        self.assertEqual(self.run_recovery(["failing", "healthy"]), (0, 2, 0, "plugin reloaded"))

    def test_unobserved_reload_never_restarts_the_daemon(self):
        self.assertEqual(self.run_recovery(["unknown"]), (1, 1, 0, "plugin running; local RPC unverified"))

    def test_restart_only_after_both_reloads_fail_and_is_verified(self):
        self.assertEqual(self.run_recovery(["failing", "failing", "healthy"]), (0, 2, 1, "daemon restarted"))
        self.assertEqual(self.run_recovery(["failing", "failing", "failing"]), (1, 2, 1, "recovery failed"))

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
