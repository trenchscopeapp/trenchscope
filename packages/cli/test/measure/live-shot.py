#!/usr/bin/env python3 -I
"""task-1303 live screenshot + row-count probe.

Runs the REAL interactive dexterm in a pty over several live refresh cycles,
then prints the LAST fully-rendered frame (ANSI stripped) and the count of
screener data rows in it. Confirms the screener holds hundreds of rows and does
not collapse to the compact feed between refreshes (defect #4).
"""
from __future__ import annotations
import fcntl, os, pty, re, select, struct, subprocess, sys, termios, time

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(os.path.join(HERE, "..", "..", "bin", "dexterm.mjs"))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
COLS, ROWS = 176, 48
SECONDS = float(sys.argv[1]) if len(sys.argv) > 1 else 40.0

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
env = dict(os.environ)
env.pop("DEXTERM_OFFLINE", None)
env["COLUMNS"], env["LINES"] = str(COLS), str(ROWS)
env["TERM"], env["COLORTERM"] = "xterm-256color", "truecolor"
proc = subprocess.Popen(["node", APP, "--no-boot", "--calm"], stdin=slave, stdout=slave,
                        stderr=subprocess.DEVNULL, env=env, cwd=ROOT, preexec_fn=os.setsid)
os.close(slave)

buf = bytearray()
t0 = time.time()
while time.time() - t0 < SECONDS:
    r, _, _ = select.select([master], [], [], 0.25)
    if r:
        try:
            d = os.read(master, 65536)
        except OSError:
            break
        if not d:
            break
        buf += d
try:
    os.killpg(os.getpgid(proc.pid), 2)  # Ctrl-C equivalent for a clean quit
    proc.wait(timeout=5)
except Exception:
    try:
        os.killpg(os.getpgid(proc.pid), 9)
    except Exception:
        pass
os.close(master)

text = buf.decode("utf-8", "replace")
# Last frame = everything after the final cursor-home. Strip CSI/OSC sequences.
parts = re.split(r"\x1b\[H", text)
frame = parts[-1] if len(parts) > 1 else text
frame = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", "", frame)   # OSC
frame = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", frame)            # CSI
frame = frame.replace("\x1b", "")
lines = [ln.rstrip() for ln in frame.split("\n")]
# A screener data row starts with a rank number then a ticker; count them.
data_rows = [ln for ln in lines if re.match(r"\s*\d+\s+\$?[A-Za-z0-9]", ln.strip()) and re.search(r"\$?\d", ln)]
hdr = next((ln.strip() for ln in lines if re.search(r"\bof\b\s*\d|\d+\s*/\s*\d+", ln)), "")

shot = os.path.join(HERE, "live-shot.txt")
with open(shot, "w") as fh:
    fh.write("\n".join(lines))
print(f"captured {len(lines)} lines over {SECONDS:.0f}s; header count line: {hdr!r}")
print(f"screener data rows in final frame: {len(data_rows)}")
print(f"frame written to {os.path.relpath(shot, ROOT)}")
