#!/usr/bin/env python3 -I
"""task-1303 defect #1 quit-timing harness.

Starts the REAL interactive dexterm in a pty, lets the live wide-pool fill run
long enough that the paced background fill is parked in a DsPacer sleep, then
sends Ctrl-C (0x03) on the pty and measures wall-clock time to process exit.

Baseline (0d803c9) was ~0.03-0.04 s; the regression (aa83124) hung 35-43 s
because the paced sleep was a plain, non-unref'd setTimeout that close() never
cancelled. The fix makes the sleep unref'd + cancellable and close() abort it.

task-1424: the app gets a throwaway cache DB (--db in a temp dir). It used to open the user's default
~/.local/share/dexterm/dexterm.db, so a run beside another lane's run (or a running dexterm) could exit 2
with "database is locked" before painting. The --wait clock (and the --open Enter at +3 s) starts at the
app's first paint (it entered the alternate screen and drew), not at spawn, so a slow start-up under CPU
load cannot eat the fill or land the Enter before the key loop is live. If it never paints, the harness
says whether the app exited or timed out and prints the tail of its stderr. The quit measurement after
the key is unchanged.

Usage: python3 -I quit-timing.py [--wait 25] [--calm] [--intensity fever] [--ready-timeout 30]
"""
from __future__ import annotations

import argparse
import fcntl
import os
import pty
import struct
import termios
import time
import select
import shutil
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(os.path.join(HERE, "..", "..", "bin", "dexterm.mjs"))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
COLS, ROWS = 176, 48


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wait", type=float, default=25.0, help="seconds to let the fill run before quitting")
    ap.add_argument("--calm", action="store_true")
    ap.add_argument("--intensity", default=None, choices=["off", "normal", "fever"])
    ap.add_argument("--key", default="ctrlc", choices=["ctrlc", "q"], help="the quit keystroke to send")
    ap.add_argument("--open", action="store_true", help="press Enter early to open a token (engages the token loader + fast lane)")
    ap.add_argument("--ready-timeout", type=float, default=30.0, help="seconds to wait for the first paint before giving up")
    args = ap.parse_args()

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    scratch = tempfile.mkdtemp(prefix="dexterm-quit-")
    argv = ["node", APP, "--no-boot", "--db", os.path.join(scratch, "dexterm.db")]
    if args.calm:
        argv.append("--calm")
    if args.intensity:
        argv += ["--intensity", args.intensity]

    env = dict(os.environ)
    env.pop("DEXTERM_OFFLINE", None)  # live feeds: we need the paced fill to run
    env["COLUMNS"], env["LINES"] = str(COLS), str(ROWS)
    env["TERM"] = env.get("TERM", "xterm-256color")
    env["COLORTERM"] = "truecolor"

    import subprocess
    errlog = os.path.join(scratch, "stderr.txt")
    proc = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=open(errlog, "wb"),
                            env=env, cwd=ROOT, preexec_fn=os.setsid)
    os.close(slave)

    # Wait for the first paint: the alternate screen entered plus a frame's worth of output after it.
    spawned = time.time()
    seen = b""
    ready = False
    while time.time() - spawned < args.ready_timeout and proc.poll() is None:
        r, _, _ = select.select([master], [], [], 0.1)
        if r:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            seen += chunk
            enter = seen.find(b"\x1b[?1049h")
            if enter >= 0 and len(seen) - enter > 2000:
                ready = True
                break
    ready_after = time.time() - spawned
    if not ready:
        code = proc.poll()
        why = f"exited (code {code}) before painting" if code is not None else f"did not paint within {args.ready_timeout:.0f} s"
        with open(errlog, "rb") as f:
            tail = f.read()[-800:].decode("utf-8", "replace").strip()
        print(f"### quit timing: the app {why}; stderr tail: {tail or '(empty)'}")
        try:
            os.killpg(os.getpgid(proc.pid), 9)
        except Exception:
            pass
        os.close(master)
        shutil.rmtree(scratch, ignore_errors=True)
        return 2

    # Drain the pty so the app's writes never block while we wait for the fill.
    t0 = time.time()
    opened = not args.open
    while time.time() - t0 < args.wait:
        # Open a token a few seconds in: ⏎ opens the highlighted row so the token loader + fast lane run.
        if not opened and time.time() - t0 > 3.0:
            os.write(master, b"\r")
            opened = True
        r, _, _ = select.select([master], [], [], 0.25)
        if r:
            try:
                if not os.read(master, 65536):
                    break
            except OSError:
                break

    # Send the quit keystroke: Ctrl-C (0x03) or `q`; both reach the app's clean quit() in raw mode.
    os.write(master, b"q" if args.key == "q" else b"\x03")
    sent = time.time()
    # Keep draining until the process exits.
    while True:
        if proc.poll() is not None:
            break
        r, _, _ = select.select([master], [], [], 0.1)
        if r:
            try:
                os.read(master, 65536)
            except OSError:
                pass
        if time.time() - sent > 60:
            break
    exit_after = time.time() - sent
    code = proc.poll()
    if code is None:
        try:
            os.killpg(os.getpgid(proc.pid), 9)
        except Exception:
            pass
    os.close(master)
    shutil.rmtree(scratch, ignore_errors=True)

    label = "calm" if args.calm else (args.intensity or "fever")
    keyname = "q" if args.key == "q" else "Ctrl-C"
    openlbl = ", token open" if args.open else ""
    print(f"### quit timing: {label} (fill {args.wait:.0f}s{openlbl}, then {keyname})")
    print(f"- first paint after {ready_after:.2f} s")
    print(f"- exit after {keyname}: {exit_after:.2f} s (exit code {code})")
    print(f"- verdict: {'PASS <1s' if exit_after < 1.0 else 'FAIL >=1s'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
