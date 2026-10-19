#!/usr/bin/env python3 -I
"""task-1313 UI-action pty harness.

Drives the REAL interactive dexterm in a pty over a recording (replay = live code
paths, no network), with a FAKE `claude` on PATH that, for one analyst turn,
writes an `open_token` line to the authenticated action channel and emits a
matching stream-json tool call. Proves that asking "put X on my screen" actually
puts the coin on screen: the app consumes the channel, applies the action, and
shows an "analyst opened …" note. Captures all pty output to --out.

Usage: python3 -I action-pty.py --sample FILE --fake-dir DIR --out FILE --home DIR

Each step waits for the screen to show the expected content (task-1410: fixed sleeps flaked under
parallel-suite CPU load — a slow boot or a slow fake `claude` spawn meant the next key landed before
the app was ready). A wait that times out just continues; the test's own assertions then fail.
Wait outcomes go to OUT.waits.txt.
"""
from __future__ import annotations

import argparse
import fcntl
import os
import struct
import termios
import time
import re
import select
import subprocess
import pty

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.abspath(os.path.join(HERE, "..", "..", "bin", "dexterm.mjs"))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
COLS, ROWS = 140, 40


CSI = re.compile(rb"\x1b\[([?0-9;]*)([A-Za-z@])")


class Grid:
    """The minimal screen model drive.py uses (cursor moves, clears, text) — enough to read the live frame."""

    def __init__(self, cols: int, rows: int) -> None:
        self.cols, self.rows = cols, rows
        self.cells = [[" "] * cols for _ in range(rows)]
        self.r = self.c = 0
        self.pending = b""

    def feed(self, data: bytes) -> None:
        buf = self.pending + data
        i = 0
        while i < len(buf):
            b = buf[i]
            if b == 0x1B:
                m = CSI.match(buf, i)
                if m:
                    params, final = m.group(1).decode(), m.group(2).decode()
                    if final in "Hf":
                        p = [int(x) if x else 1 for x in params.split(";")] if params else [1, 1]
                        self.r = max(0, min(self.rows - 1, (p[0] if p else 1) - 1))
                        self.c = max(0, min(self.cols - 1, (p[1] if len(p) > 1 else 1) - 1))
                    elif final == "J" and params in ("", "2"):
                        self.cells = [[" "] * self.cols for _ in range(self.rows)]
                    elif final == "K":
                        for c in range(self.c, self.cols):
                            self.cells[self.r][c] = " "
                    i = m.end()
                    continue
                if i + 1 >= len(buf) or buf[i + 1:i + 2] == b"[":
                    self.pending = buf[i:]
                    return
                if buf[i + 1:i + 2] == b"]":  # OSC ... BEL/ST
                    ends = [x for x in (buf.find(b"\x07", i), buf.find(b"\x1b\\", i)) if x >= 0]
                    if not ends:
                        self.pending = buf[i:]
                        return
                    e = min(ends)
                    i = e + (1 if buf[e] == 0x07 else 2)
                    continue
                i += 2
                continue
            if b == 0x0D:
                self.c = 0
                i += 1
                continue
            if b == 0x0A:
                self.r = min(self.rows - 1, self.r + 1)
                i += 1
                continue
            if b < 0x20:
                i += 1
                continue
            n = 1 if b < 0x80 else 2 if b < 0xE0 else 3 if b < 0xF0 else 4
            if i + n > len(buf):
                self.pending = buf[i:]
                return
            ch = buf[i:i + n].decode("utf-8", errors="replace")
            i += n
            if ch in "\u200b\ufe0f" or (len(ch) == 1 and 0x300 <= ord(ch) <= 0x36F):
                continue
            if self.c < self.cols:
                self.cells[self.r][self.c] = ch
            self.c += 1
        self.pending = b""

    def text(self) -> str:
        return "\n".join("".join(row).rstrip() for row in self.cells)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", required=True)
    ap.add_argument("--fake-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--home", required=True)
    ap.add_argument("--fake-log", default="")
    ap.add_argument("--scenario", default="open", choices=["open", "filter", "results"])
    args = ap.parse_args()

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    # task-1424: a per-run cache DB under the temp home. Replay mode otherwise opens the user's default
    # ~/.local/share/dexterm/dexterm.db, which another lane (or a running dexterm) may hold locked:
    # the app then exits 2 with "database is locked" before it paints.
    argv = ["node", BIN, "--replay", args.sample, "--no-boot", "--tz", "UTC", "--db", os.path.join(args.home, "dexterm.db")]
    env = dict(os.environ)
    env["PATH"] = args.fake_dir + os.pathsep + env.get("PATH", "")
    env["DEXTERM_OFFLINE"] = "1"
    env["DEXTERM_HOME"] = args.home
    env["COLUMNS"], env["LINES"] = str(COLS), str(ROWS)
    env["TERM"] = env.get("TERM", "xterm-256color")
    env["COLORTERM"] = "truecolor"
    if args.fake_log:
        env["DEXTERM_FAKE_LOG"] = args.fake_log
    env["DEXTERM_FAKE_SCENARIO"] = args.scenario

    proc = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=subprocess.DEVNULL,
                            env=env, cwd=ROOT, preexec_fn=os.setsid)
    os.close(slave)

    buf = bytearray()
    grid = Grid(COLS, ROWS)
    waits: list[str] = []
    t_start = time.time()

    def drain(seconds: float) -> None:
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([master], [], [], 0.1)
            if r:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    return
                if not chunk:
                    return
                buf.extend(chunk)
                grid.feed(chunk)

    def wait_for(pattern: str, limit: float, settle: float = 0.2) -> None:
        """Drain until the live frame matches `pattern` (regex) or `limit` seconds pass, then `settle`."""
        rx = re.compile(pattern, re.I)
        t0 = time.time()
        while time.time() - t0 < limit and not rx.search(grid.text()):
            drain(0.05)
            if proc.poll() is not None:
                break
        hit = bool(rx.search(grid.text()))
        waits.append(f"t={time.time() - t_start:.1f}s {'ok' if hit else 'TIMEOUT'} {time.time() - t0:.1f}s {pattern}")
        drain(settle)

    def send(data: bytes) -> None:
        os.write(master, data)

    prompts = {
        "open": b"put the top coin on my screen",
        "filter": b"show me coins under 5M mcap with over 100k liquidity, up on the day, not rugs",
        "results": b"what are the best setups right now",
    }
    answered = {
        "open": r"analyst opened",
        "filter": r"analyst filter|filter mcap|mcap < 5M",
        "results": r"setup reason 1",
    }
    wait_for(r"SCREENER[─ ]+[1-9]\d* tokens", 30, settle=0.5)  # the replay feed filled the screener
    send(b"4")              # Analyst tab
    wait_for(r"✦ ANALYST", 15)
    send(b"i")              # focus the chat input
    drain(0.4)
    send(prompts[args.scenario])
    wait_for(re.escape(prompts[args.scenario][:16].decode()), 10)
    send(b"\r")             # send the question → spawns the fake claude → writes the action
    wait_for(answered[args.scenario], 30, settle=0.5)  # the app consumed the channel / rendered the answer
    if args.scenario == "results":
        send(b"\x1b")       # blur the input so the results table takes the arrows
        drain(0.3)
        send(b"\x1b[B")     # ↓ activate + move the results cursor
        drain(0.3)
        send(b"\r")         # ⏎ jump to the selected coin's token screen
        wait_for(r"ON-CHAIN", 15)
    send(b"q")              # quit
    # keep draining until exit
    t0 = time.time()
    while time.time() - t0 < 6:
        if proc.poll() is not None:
            break
        drain(0.2)
    if proc.poll() is None:
        try:
            os.killpg(os.getpgid(proc.pid), 9)
        except ProcessLookupError:
            pass
    drain(0.3)

    with open(args.out, "wb") as f:
        f.write(bytes(buf))
    with open(args.out + ".waits.txt", "w", encoding="utf-8") as f:
        f.write("\n".join(waits) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
