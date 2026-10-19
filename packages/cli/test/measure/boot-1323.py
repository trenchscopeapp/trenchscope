#!/usr/bin/env python3 -I
"""task-1323 item 1: time-to-first-rows of the REAL interactive dexterm (live, free tier) in a pty.

COLD = fresh DEXTERM_HOME + fresh XDG_DATA_HOME (empty cache DB). WARM = the same dirs again after a
previous run left its cache (and, after the fix, its feed snapshot) behind. The app is started with
--no-boot and a pre-seeded state.json ({"boots":5}) so no welcome card / boot animation is in the way.

Timing comes from two clocks:
  - harness: wall clock from spawn to the moment the DEXTERM_TRACE file shows the milestone;
  - app:     the trace line's own `performance.now()` (ms since the node process started).
Milestones: first-frame, first-skeleton (after fix), first-rows (any rows on screen: cached or fresh),
first-fresh-rows (after fix: rows from this run's network fetch).

Usage: python3 -I boot-1323.py [--runs 3] [--seconds 30] [--settle 12] [--extra ARG ...]
"""
from __future__ import annotations
import argparse, fcntl, json, os, pty, select, shutil, struct, subprocess, tempfile, termios, time

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(os.path.join(HERE, "..", "..", "bin", "dexterm.mjs"))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
COLS, ROWS = 176, 48
STDERR = os.environ.get("BOOT1323_STDERR")
EVENTS = ("first-frame", "first-skeleton", "first-rows", "first-fresh-rows", "fallback")


def read_trace(path: str) -> dict:
    out = {}
    try:
        with open(path) as f:
            for line in f:
                parts = line.strip().split(" ", 2)
                if len(parts) >= 2 and parts[1] not in out:
                    out[parts[1]] = {"app_ms": int(parts[0]), "detail": parts[2] if len(parts) > 2 else ""}
    except FileNotFoundError:
        pass
    return out


def one_run(home: str, data: str, seconds: float, settle: float, extra: list[str]) -> dict:
    trace = os.path.join(home, f"trace-{time.time_ns()}.txt")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    env = dict(os.environ)
    env.pop("DEXTERM_OFFLINE", None)
    env.update({"DEXTERM_HOME": home, "XDG_DATA_HOME": data, "DEXTERM_TRACE": trace,
                "COLUMNS": str(COLS), "LINES": str(ROWS), "TERM": env.get("TERM", "xterm-256color"), "COLORTERM": "truecolor"})
    t0 = time.time()
    proc = subprocess.Popen(["node", APP, "--no-boot", *extra], stdin=slave, stdout=slave, stderr=(open(STDERR, "ab") if STDERR else subprocess.DEVNULL),
                            env=env, cwd=ROOT, preexec_fn=os.setsid)
    os.close(slave)
    wall = {}
    settled = False
    stop_at = t0 + seconds
    while time.time() < stop_at:
        r, _, _ = select.select([master], [], [], 0.01)
        if r:
            try:
                if not os.read(master, 65536):
                    break
            except OSError:
                break
        tr = read_trace(trace)
        for e in EVENTS:
            if e in tr and e not in wall:
                wall[e] = round((time.time() - t0) * 1000)
        if "first-rows" in wall and not settled:
            settled = True
            stop_at = min(stop_at, time.time() + settle)
    os.write(master, b"q")
    time.sleep(0.5)
    try:
        os.killpg(os.getpgid(proc.pid), 9)
    except Exception:
        pass
    os.close(master)
    tr = read_trace(trace)
    return {e: {"wall_ms": wall.get(e), **tr.get(e, {})} for e in EVENTS if e in tr or e in wall}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--seconds", type=float, default=30.0)
    ap.add_argument("--settle", type=float, default=12.0, help="keep running after first rows so the cache/snapshot is written")
    ap.add_argument("--extra", nargs="*", default=[])
    a = ap.parse_args()
    results = []
    for i in range(a.runs):
        base = tempfile.mkdtemp(prefix="dexterm-1323-boot-")
        home, data = os.path.join(base, "home"), os.path.join(base, "data")
        os.makedirs(home)
        with open(os.path.join(home, "state.json"), "w") as f:
            json.dump({"version": 1, "boots": 5}, f)
        cold = one_run(home, data, a.seconds, a.settle, a.extra)
        time.sleep(1.0)
        warm = one_run(home, data, a.seconds, a.settle, a.extra)
        results.append({"run": i + 1, "cold": cold, "warm": warm})
        print(json.dumps(results[-1]))
        shutil.rmtree(base, ignore_errors=True)
        time.sleep(3.0)
    def col(kind: str, ev: str) -> list[int]:
        return [r[kind][ev]["app_ms"] for r in results if ev in r[kind] and r[kind][ev].get("app_ms") is not None]
    print("\nSUMMARY (ms since process start, per run)")
    for kind in ("cold", "warm"):
        for ev in EVENTS:
            xs = col(kind, ev)
            if xs:
                print(f"  {kind:4} {ev:17} {xs}  median {sorted(xs)[len(xs) // 2]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
