#!/usr/bin/env python3
"""Holds the host's plugin-rollout lock for a command.

    flock.py <lock-file> <deadline-epoch-ms> <command> [args...]

Takes an exclusive kernel flock on <lock-file>, polling until the deadline, then execs <command>
with the locked descriptor left open and inheritable. Every argument equal to @LOCKFD@ is replaced
by that descriptor's number, so the command can pass it on to its own children. The lock is held
until the command and every process that inherited the descriptor have exited; the kernel releases
it when they die, so there is no stale lock to clean up.
"""

import fcntl
import os
import sys
import time


def main(argv):
    if len(argv) < 4:
        print(__doc__.strip(), file=sys.stderr)
        return 64
    lock_file, deadline_ms, command = argv[1], int(argv[2]), argv[3:]
    os.makedirs(os.path.dirname(os.path.abspath(lock_file)), exist_ok=True)
    fd = os.open(lock_file, os.O_RDWR | os.O_CREAT, 0o644)
    announced = False
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.time() * 1000 >= deadline_ms:
                print(
                    f"another plugin rollout still holds {lock_file}; gave up at the deadline, nothing changed",
                    file=sys.stderr,
                )
                return 1
            if not announced:
                print(f"waiting for another plugin rollout ({lock_file})", flush=True)
                announced = True
            time.sleep(0.2)
    os.set_inheritable(fd, True)
    command = [str(fd) if arg == "@LOCKFD@" else arg for arg in command]
    sys.stdout.flush()
    os.execvp(command[0], command)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
