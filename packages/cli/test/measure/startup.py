#!/usr/bin/env python3 -I
"""task-1319 item 4: startup time to first frame + resident memory (RSS).

Starts the REAL interactive dexterm in a pty and measures:
  - time from spawn to the first painted frame (first screen-home / clear + content on the pty), and
  - RSS (resident set size) sampled via `ps -o rss=` at first frame and after a short settle.

Usage: python3 -I startup.py [--seconds 20] [--calm] [--intensity fever|normal] [--no-boot] [--runs 3]
"""
from __future__ import annotations
import argparse, fcntl, os, pty, select, struct, subprocess, termios, time

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(os.path.join(HERE, "..", "..", "bin", "dexterm.mjs"))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
COLS, ROWS = 176, 48


def rss_kib(pid: int) -> int:
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True)
        return int(out.stdout.strip() or 0)
    except Exception:
        return 0


def one_run(args) -> dict:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    argv = ["node", APP]
    if args.no_boot:
        argv.append("--no-boot")
    if args.calm:
        argv.append("--calm")
    if args.intensity:
        argv += ["--intensity", args.intensity]
    env = dict(os.environ)
    env.pop("DEXTERM_OFFLINE", None)
    env["COLUMNS"], env["LINES"] = str(COLS), str(ROWS)
    env["TERM"] = env.get("TERM", "xterm-256color")
    env["COLORTERM"] = "truecolor"
    t0 = time.time()
    proc = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=subprocess.DEVNULL,
                            env=env, cwd=ROOT, preexec_fn=os.setsid)
    os.close(slave)
    first_frame = None
    seen = 0
    rss_first = 0
    # First frame = the first pty write that homes the cursor / clears and carries content.
    while time.time() - t0 < args.seconds:
        r, _, _ = select.select([master], [], [], 0.05)
        if r:
            try:
                d = os.read(master, 65536)
            except OSError:
                break
            if not d:
                break
            seen += len(d)
            if first_frame is None and (b"\x1b[H" in d or b"\x1b[2J" in d or b"\x1b[1;1H" in d) and seen > 64:
                first_frame = time.time() - t0
                rss_first = rss_kib(proc.pid)
        if first_frame is not None and time.time() - t0 > first_frame + args.settle:
            break
    rss_settle = rss_kib(proc.pid)
    # quit
    os.write(master, b"q")
    time.sleep(0.3)
    try:
        os.killpg(os.getpgid(proc.pid), 9)
    except Exception:
        pass
    os.close(master)
    return {"first_frame_ms": None if first_frame is None else round(first_frame * 1000),
            "rss_first_mib": round(rss_first / 1024, 1), "rss_settle_mib": round(rss_settle / 1024, 1)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=20.0)
    ap.add_argument("--settle", type=float, default=6.0, help="seconds to keep running after first frame (for RSS)")
    ap.add_argument("--calm", action="store_true")
    ap.add_argument("--intensity", default=None, choices=["off", "normal", "fever"])
    ap.add_argument("--no-boot", action="store_true", help="skip the boot animation (measure the screener paint)")
    ap.add_argument("--runs", type=int, default=3)
    args = ap.parse_args()

    label = ("calm" if args.calm else (args.intensity or "fever")) + (" --no-boot" if args.no_boot else " (full boot)")
    runs = [one_run(args) for _ in range(args.runs)]
    ff = [r["first_frame_ms"] for r in runs if r["first_frame_ms"] is not None]
    print(f"### startup: {label} ({args.runs} runs, pty {COLS}x{ROWS})")
    for i, r in enumerate(runs):
        print(f"- run {i+1}: first frame {r['first_frame_ms']} ms · RSS {r['rss_first_mib']} MiB @first, {r['rss_settle_mib']} MiB @+{args.settle:.0f}s")
    if ff:
        ff.sort()
        print(f"- first frame: median {ff[len(ff)//2]} ms · min {ff[0]} · max {ff[-1]}")
    rs = sorted(r["rss_settle_mib"] for r in runs)
    print(f"- RSS @settle: median {rs[len(rs)//2]} MiB · min {rs[0]} · max {rs[-1]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
