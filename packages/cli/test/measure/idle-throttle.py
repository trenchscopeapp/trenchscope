#!/usr/bin/env python3 -I
"""task-1319 AC3 follow-up: idle-throttle measurement harness (the QA pty driver).

Drives the REAL interactive dexterm over a pseudo-terminal for a fixed window and reports:
  * cpu_median / cpu_p90 / cpu_mean  — node process CPU% from `ps -o cputime` deltas at 1 Hz
                                        (sampled after a warm-up, so startup is excluded)
  * fps_window                        — painted frames per second over the sampled window
                                        (a frame = one non-empty flusher paint, counted by the
                                        hide-cursor prefix the flusher writes once per paint)
  * wake_fps                          — frames in the first second after a keypress sent once the
                                        loop has been idle > 6 s (proves the throttle lifts instantly)
Modes:
  --mode idle    nobody types (default)
  --mode scroll  j/k alternately every --scroll-ms (default 150) for the whole window → "active" cost
Usage:
  python3 -I idle-throttle.py --cwd <worktree> --seconds 130 [--mode idle|scroll] [--label L] -- <dexterm args>
Prints one JSON line to stdout. Nothing about this script is specific to the fix; run it against the
pre-fix build too for a before/after under identical conditions.
"""
from __future__ import annotations

import fcntl
import json
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

argv = sys.argv[1:]


def opt(k: str, d: str | None = None) -> str | None:
    if k in argv:
        i = argv.index(k); v = argv[i + 1]; del argv[i:i + 2]; return v
    return d


cwd = opt('--cwd', os.getcwd()) or os.getcwd()
label = opt('--label', 'run') or 'run'
seconds = float(opt('--seconds', '130') or '130')
warm = float(opt('--warm', '12') or '12')          # seconds before sampling starts (first data normally lands < 12 s)
mode = opt('--mode', 'idle') or 'idle'
scroll_ms = float(opt('--scroll-ms', '150') or '150')
app_args = argv[argv.index('--') + 1:] if '--' in argv else []
COLS, ROWS = 176, 48
FRAME_RE = re.compile(rb'\x1b\[\?25l')   # the hide-cursor prefix the flusher emits once per non-empty paint


def cputime(pid: int) -> float | None:
    try:
        out = subprocess.run(['ps', '-o', 'cputime=', '-p', str(pid)], capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return None
    if not out:
        return None
    days = 0
    if '-' in out:
        d, out = out.split('-', 1); days = int(d)
    sec = 0.0
    for p in out.split(':'):
        sec = sec * 60 + float(p)
    return days * 86400 + sec


env = dict(os.environ); env.pop('DEXTERM_OFFLINE', None)
env.update(COLUMNS=str(COLS), LINES=str(ROWS), TERM='xterm-256color', COLORTERM='truecolor')
cmd = ['node', 'packages/cli/bin/dexterm.mjs'] + app_args
t0 = time.time()
pid, master = pty.fork()
if pid == 0:
    os.chdir(cwd)
    fd2 = os.open('/dev/null', os.O_WRONLY); os.dup2(fd2, 2)
    os.execvpe(cmd[0], cmd, env)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))

code: int | None = None
frames = 0


def poll() -> int | None:
    global code
    if code is None:
        try:
            p, st = os.waitpid(pid, os.WNOHANG)
            if p:
                code = os.waitstatus_to_exitcode(st)
        except ChildProcessError:
            code = -999
    return code


def pump(timeout: float = 0.05) -> bool:
    """Drain the pty; count painted frames. Returns False when the slave side is gone."""
    global frames
    r, _, _ = select.select([master], [], [], timeout)
    if not r:
        return True
    try:
        d = os.read(master, 1 << 16)
    except OSError:
        return False
    if not d:
        return False
    frames += len(FRAME_RE.findall(d))
    return True


def run_for(secs: float, key_every: float | None = None) -> tuple[list[float], int]:
    """Pump for `secs`; sample CPU at 1 Hz; optionally send j/k alternately every key_every s."""
    samples: list[float] = []
    f0 = frames
    end = time.time() + secs
    last = None
    next_sample = time.time()
    next_key = time.time()
    k = 0
    while time.time() < end and poll() is None:
        pump(0.02)
        now = time.time()
        if key_every is not None and now >= next_key:
            os.write(master, b'j' if k % 2 == 0 else b'k'); k += 1; next_key = now + key_every
        if now >= next_sample:
            ct = cputime(pid)
            if ct is not None and last is not None:
                samples.append(100.0 * (ct - last[0]) / (now - last[1]))
            if ct is not None:
                last = (ct, now)
            next_sample = now + 1.0
    return samples, frames - f0


res: dict = {'label': label, 'mode': mode, 'args': app_args}
# warm-up: let the feeds land and the loop settle (no sampling)
run_for(warm)
res['warm_s'] = warm
# measured window
samples, nf = run_for(seconds, (scroll_ms / 1000.0) if mode == 'scroll' else None)
if samples:
    s = sorted(samples)
    res.update(cpu_median=round(s[len(s) // 2], 1), cpu_mean=round(sum(s) / len(s), 1), cpu_p90=round(s[int(len(s) * 0.9)], 1), cpu_n=len(s))
res.update(frames=nf, fps_window=round(nf / seconds, 1), window_s=seconds)
# wake probe (idle mode only): the loop has had > 6 s with no key → one key → frames in the next 1 s
if mode == 'idle' and poll() is None:
    run_for(6.5)
    os.write(master, b'j')
    _, wf = run_for(1.0)
    res['wake_fps'] = wf
    # and after the wake window closes (5 s + 1 s margin) the loop must throttle again
    run_for(6.0)
    _, idle_again = run_for(3.0)
    res['idle_again_fps'] = round(idle_again / 3.0, 1)
try:
    res['rss_mib'] = round(int(subprocess.run(['ps', '-o', 'rss=', '-p', str(pid)], capture_output=True, text=True).stdout.strip() or 0) / 1024, 1)
except Exception:
    pass
if poll() is None:
    os.write(master, b'q'); sent = time.time()
    while poll() is None and time.time() - sent < 30:
        pump(0.05)
    res['quit_ms'] = round((time.time() - sent) * 1000)
res['exit'] = poll()
if poll() is None:
    try:
        os.killpg(os.getpgid(pid), signal.SIGKILL)
    except Exception:
        pass
    res['killed'] = True
try:
    os.close(master)
except OSError:
    pass
print(json.dumps(res))
