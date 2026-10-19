#!/usr/bin/env python3 -I
"""task-1303 pty measurement harness.

Drives the REAL interactive dexterm over a pseudo-terminal (not the one-shot
`--screen screener` mode, which exits after one frame and therefore reports a
bogus ~0% CPU). Runs for a fixed idle window, samples the node process CPU via
`ps`, and parses the `--verbose` request log (written to its own file, not the
pty) for per-source requests/min.

Usage:
    python3 -I measure.py --seconds 130 [--calm] [--intensity normal|fever]

It never sends input beyond an optional warm-up; the point is to measure IDLE
cost (the app refreshing live feeds on its own cadence with nobody typing).
Prints a markdown block to stdout.
"""
from __future__ import annotations

import argparse
import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(os.path.join(HERE, "..", "..", "bin", "dexterm.mjs"))
COLS, ROWS = 176, 48


def set_winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def cputime_seconds(pid: int) -> float | None:
    """Cumulative CPU time (user+sys) for pid in seconds via `ps -o cputime=`.

    macOS `%cpu` is a lifetime-decaying average that the startup spike skews, so
    we instead difference cumulative CPU time between samples to get a true
    instantaneous utilisation. Returns None if the process is gone.
    """
    try:
        out = subprocess.run(
            ["ps", "-o", "cputime=", "-p", str(pid)],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
    except Exception:
        return None
    if not out:
        return None
    # formats: MM:SS.ss or HH:MM:SS.ss or DD-HH:MM:SS
    days = 0
    if "-" in out:
        d, out = out.split("-", 1)
        days = int(d)
    parts = out.split(":")
    try:
        parts = [float(p) for p in parts]
    except ValueError:
        return None
    sec = 0.0
    for p in parts:
        sec = sec * 60 + p
    return days * 86400 + sec


def median(xs: list[float]) -> float:
    s = sorted(xs)
    n = len(s)
    if n == 0:
        return 0.0
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=130.0)
    ap.add_argument("--calm", action="store_true")
    ap.add_argument("--intensity", default=None, choices=["off", "normal", "fever"])
    ap.add_argument("--label", default=None)
    args = ap.parse_args()

    log_path = os.path.join(HERE, f"reqlog-{'calm' if args.calm else (args.intensity or 'fever')}.txt")
    log = open(log_path, "w")

    master, slave = pty.openpty()
    set_winsize(slave, ROWS, COLS)

    argv = ["node", APP, "--verbose", "--no-boot"]
    if args.calm:
        argv.append("--calm")
    if args.intensity:
        argv += ["--intensity", args.intensity]

    env = dict(os.environ)
    env.pop("DEXTERM_OFFLINE", None)   # we WANT live feeds for a real measurement
    env["COLUMNS"] = str(COLS)
    env["LINES"] = str(ROWS)
    env["TERM"] = env.get("TERM", "xterm-256color")
    env["COLORTERM"] = "truecolor"

    proc = subprocess.Popen(
        argv, stdin=slave, stdout=slave, stderr=log,
        env=env, cwd=os.path.abspath(os.path.join(HERE, "..", "..", "..", "..")),
        preexec_fn=os.setsid,
    )
    os.close(slave)

    cpu: list[float] = []
    frames = 0
    t0 = time.time()
    WARMUP = 8.0          # skip startup paint/discovery spike before sampling
    next_cpu = t0 + WARMUP
    last_ct: float | None = None
    last_t: float | None = None
    try:
        while time.time() - t0 < args.seconds:
            r, _, _ = select.select([master], [], [], 0.25)
            if r:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                frames += data.count(b"\x1b[H") + data.count(b"\x1b[2J")
            now = time.time()
            if now >= next_cpu:
                ct = cputime_seconds(proc.pid)
                if ct is not None:
                    if last_ct is not None and last_t is not None and now > last_t:
                        pct = 100.0 * (ct - last_ct) / (now - last_t)
                        if now - t0 >= WARMUP:
                            cpu.append(max(0.0, pct))
                    last_ct, last_t = ct, now
                next_cpu = now + 1.0
    finally:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except Exception:
            pass
        try:
            proc.wait(timeout=5)
        except Exception:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:
                pass
        os.close(master)
        log.flush()
        log.close()

    # ---- parse the verbose request log for per-source counts + the fast-lane subscription state.
    per: dict[str, int] = {}
    rows_seen = 0
    subs_max = 0            # peak fast-lane accountSubscribe subscriptions (task-1312)
    fast_last: str | None = None
    with open(log_path, "r", errors="replace") as fh:
        for line in fh:
            m = re.match(r"\s+([a-z0-9-]+)\s+(\d{3}|ERR)\s+\d+ms", line)
            if m and m.group(1) != "fastlane":
                per[m.group(1)] = per.get(m.group(1), 0) + 1
            rm = re.search(r"(\d+) rows,", line)
            if rm:
                rows_seen = max(rows_seen, int(rm.group(1)))
            fm = re.search(r"fastlane\s+subs=(\d+)\s+tracked=(\d+)\s+live=(\d+)\s+state=(\S+)\s+ep=(.+)$", line)
            if fm:
                subs_max = max(subs_max, int(fm.group(1)))
                fast_last = f"subs={fm.group(1)} tracked={fm.group(2)} live={fm.group(3)} state={fm.group(4)} ep={fm.group(5).strip()}"

    dur_min = max(1e-9, (time.time() - t0)) / 60.0
    label = args.label or ("calm" if args.calm else (args.intensity or "fever"))
    print(f"### measurement: {label} ({args.seconds:.0f} s idle, pty {COLS}x{ROWS})")
    print()
    print(f"- samples: {len(cpu)} CPU readings (1 Hz, first 5 s skipped)")
    print(f"- idle CPU: median {median(cpu):.1f}% · range {min(cpu) if cpu else 0:.1f}–{max(cpu) if cpu else 0:.1f}%")
    print(f"- frames painted (ESC[H / clears seen on the pty): {frames}")
    print(f"- rows (max seen in verbose log): {rows_seen}")
    print("- requests/min by source:")
    for src in sorted(per):
        rpm = per[src] / dur_min
        print(f"    - {src}: {per[src]} total → {rpm:.1f}/min")
    print(f"- fast-lane subscriptions (accountSubscribe): peak {subs_max}" + (f" · last: {fast_last}" if fast_last else " · (no fast-lane status seen — open a token or watch a pump token)"))
    print(f"- request log: {os.path.relpath(log_path, os.path.abspath(os.path.join(HERE, '..', '..', '..', '..')))}")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
