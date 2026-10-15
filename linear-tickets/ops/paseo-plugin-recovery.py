#!/usr/bin/env python3
"""Independent server087 monitor for a failed or unresponsive linear-tickets plugin.

Only a healthy Paseo daemon is eligible: systemd already supervises daemon exits.
The governor's linear.capacity RPC is a local liveness signal, not a Linear API call.
A deliberate plugin disable and a stale governor observation never trigger recovery.
"""
import fcntl
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

HOME = Path.home()
BASE = HOME / ".paseo" / "linear-tickets"
STATE = BASE / "plugin-recovery.json"
LOCK = BASE / "plugin-recovery.lock"
ROLLOUT_LOCK = HOME / ".paseo" / "plugin-rollout.lock"
GOVERNOR = HOME / ".paseo" / "governor" / "state.json"
PASEO = str(HOME / ".local" / "bin" / "paseo")
PATH = f"{HOME}/.local/bin:{HOME}/.local/share/mise/shims:{os.environ.get('PATH', '/usr/bin:/bin')}"
ENV = {**os.environ, "PATH": PATH, "XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}"}
INTERVAL_FAILURES = 3
COOLDOWN = 3600
DAILY_ATTEMPTS = 2
DAY = 86400
GOVERNOR_MAX_AGE = 90


def command(args, timeout):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=ENV)
        return result.returncode == 0, result.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return False, ""


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def save(state):
    temporary = STATE.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(state, sort_keys=True) + "\n")
    os.replace(temporary, STATE)


def plugin_status():
    ok, output = command([PASEO, "plugin", "ls", "--json"], 15)
    if not ok:
        return None
    try:
        return next((item for item in json.loads(output) if item.get("id") == "linear-tickets"), {"status": "missing", "enabled": False})
    except (ValueError, TypeError):
        return None


def liveness(now, daemon_active, plugin, governor):
    """Return healthy, failing, or unknown; unknown observations must not restart Paseo."""
    if not daemon_active:
        return "unknown", "daemon not active; systemd supervises its process"
    if plugin is not None and not plugin.get("enabled", False):
        return "unknown", "plugin deliberately disabled or uninstalled"
    if plugin is not None and plugin.get("status") not in ("running", "loading"):
        return "failing", f"plugin status {plugin.get('status')}"
    if plugin is not None and plugin.get("status") == "loading":
        return "failing", "plugin still loading"
    at = governor.get("at") if isinstance(governor, dict) else None
    try:
        age = now - datetime.fromisoformat(at.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        age = float("inf")
    if 0 <= age < GOVERNOR_MAX_AGE:
        if governor.get("leaseOk") is False and str(governor.get("reason", "")).startswith("plugin unavailable:"):
            return "failing", "governor local RPC failed"
        if plugin is not None and plugin.get("status") == "running" and governor.get("leaseOk") is True:
            return "healthy", "plugin running and local RPC responsive"
    return "unknown", "plugin or local RPC observation unavailable"


def next_state(previous, condition, now):
    state = dict(previous) if isinstance(previous, dict) else {}
    recorded = state.get("attempts")
    attempts = [at for at in recorded if isinstance(at, (int, float)) and 0 <= now - at < DAY] if isinstance(recorded, list) else []
    old_failures = state.get("failures")
    failures = (old_failures if type(old_failures) is int and old_failures >= 0 else 0) + 1 if condition == "failing" else 0
    state.update(attempts=attempts, failures=failures, checkedAt=now, condition=condition)
    eligible = (condition == "failing" and failures >= INTERVAL_FAILURES and
                len(attempts) < DAILY_ATTEMPTS and (not attempts or now - attempts[-1] >= COOLDOWN))
    return state, eligible


def reload_verified(entry):
    """A running status alone is insufficient: the outage also broke local plugin RPC."""
    if not entry or not entry.get("enabled") or entry.get("status") != "running":
        return "failing"
    for attempt in range(4):
        condition, _ = liveness(time.time(), True, entry, read_json(GOVERNOR))
        if condition == "healthy":
            return condition
        if attempt < 3:
            time.sleep(10)
    return condition


def main():
    BASE.mkdir(parents=True, exist_ok=True)
    # Hold the same lock as plugin-rollout for this entire check/recovery. Otherwise a
    # slow, intentional reload could be mistaken for an outage and restarted mid-rollout.
    with ROLLOUT_LOCK.open("a") as rollout:
        try:
            fcntl.flock(rollout, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("plugin recovery: rollout in progress; skipping this check")
            return 0
        return check_and_recover()


def check_and_recover():
    with LOCK.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        now = time.time()
        daemon_active, output = command(["systemctl", "--user", "is-active", "paseo.service"], 5)
        plugin = plugin_status() if daemon_active and output == "active" else None
        governor = read_json(GOVERNOR)
        condition, reason = liveness(now, daemon_active and output == "active", plugin, governor)
        state, eligible = next_state(read_json(STATE), condition, now)
        state["reason"] = reason
        if not eligible:
            save(state)
            if condition == "failing" or (condition == "unknown" and reason != "plugin deliberately disabled or uninstalled"):
                print(f"plugin recovery: {condition}: {reason}; consecutive failures {state['failures']}")
            return 0
        # Persist before invoking commands which may block or restart this process.
        state["attempts"].append(now)
        state["lastAction"] = "attempting plugin reload"
        save(state)
        print(f"plugin recovery: {reason} for {state['failures']} checks; reloading plugin", flush=True)
        reloaded, _ = command([PASEO, "plugin", "reload", "linear-tickets", "--json"], 75)
        verified = reload_verified(plugin_status()) if reloaded else "failing"
        if verified == "healthy":
            state["lastAction"] = "plugin reloaded"
        elif verified == "unknown":
            # An unobserved governor must not justify a daemon restart.
            state["lastAction"] = "plugin running; local RPC unverified"
        else:
            # A stuck worker can block reload; this recovered the 2026-10-15 outage.
            print("plugin recovery: reload did not restore local RPC; restarting Paseo daemon", flush=True)
            restarted, _ = command(["systemctl", "--user", "restart", "paseo.service"], 200)
            entry = plugin_status() if restarted else None
            state["lastAction"] = "daemon restarted" if entry and entry.get("status") == "running" else "recovery failed"
        save(state)
        print(f"plugin recovery: {state['lastAction']}", flush=True)
        return 0 if state["lastAction"] in ("plugin reloaded", "daemon restarted") else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BlockingIOError:
        print("plugin recovery: another check is running")
    except Exception as error:
        print(f"plugin recovery: monitor failed: {error}", file=sys.stderr)
        sys.exit(1)
