#!/usr/bin/env python3
"""Measure idle CPU of the interactive app for N seconds inside a pseudo-terminal (no real terminal needed).

usage: python3 -I packages/cli/tools/cpu-measure.py [--seconds 60] [--cols 176 --rows 48] [-- extra dexterm args…]

Spawns `node packages/cli/bin/dexterm.mjs --fixtures --no-boot <args>` on a 176×48 pty with COLORTERM=truecolor
and DEXTERM_OFFLINE=1, drains its output (so it never blocks on write), and reports: mean of `ps %cpu` samples,
total CPU time (utime+stime from `ps -o cputime`) divided by wall time, and bytes written to the pty.
Same method as prototype-v2/tools/cpu-measure.py (VISUAL-V2 §4).
"""
import os, pty, sys, time, fcntl, termios, struct, subprocess, threading, signal, tempfile

args = sys.argv[1:]
seconds = 60
cols, rows = 176, 48
if '--seconds' in args:
    i = args.index('--seconds'); seconds = int(args[i + 1]); del args[i:i + 2]
if '--cols' in args:
    i = args.index('--cols'); cols = int(args[i + 1]); del args[i:i + 2]
if '--rows' in args:
    i = args.index('--rows'); rows = int(args[i + 1]); del args[i:i + 2]
extra = args[args.index('--') + 1:] if '--' in args else args
here = os.path.dirname(os.path.abspath(__file__))
repo = os.path.dirname(os.path.dirname(os.path.dirname(here)))
home = tempfile.mkdtemp(prefix='dexterm-cpu-')

pid, fd = pty.fork()
if pid == 0:
    os.chdir(repo)
    os.environ['COLORTERM'] = 'truecolor'
    os.environ['DEXTERM_OFFLINE'] = '1'
    os.environ['DEXTERM_HOME'] = home
    os.execvp('node', ['node', 'packages/cli/bin/dexterm.mjs', '--fixtures', '--no-boot', *extra])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
os.kill(pid, signal.SIGWINCH)
nbytes = [0]
def drain():
    while True:
        try:
            data = os.read(fd, 65536)
        except OSError:
            return
        if not data:
            return
        nbytes[0] += len(data)
threading.Thread(target=drain, daemon=True).start()

def cputime():
    out = subprocess.run(['ps', '-o', 'cputime=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()
    secs = 0.0
    for p in out.split(':'):
        secs = secs * 60 + float(p)
    return secs

time.sleep(2.0)  # let it settle past the first frames
t0 = time.time(); c0 = cputime(); b0 = nbytes[0]
samples = []
while time.time() - t0 < seconds:
    time.sleep(2.0)
    out = subprocess.run(['ps', '-o', '%cpu=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()
    try:
        samples.append(float(out))
    except ValueError:
        pass
t1 = time.time(); c1 = cputime(); b1 = nbytes[0]
os.write(fd, b'q')
time.sleep(0.3)
try:
    os.kill(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
wall = t1 - t0
print(f"args: {' '.join(extra) or '(default)'}  ·  {cols}×{rows} pty")
print(f"wall {wall:.1f}s · cpu time {c1 - c0:.1f}s → {100 * (c1 - c0) / wall:.1f}% of one core")
print(f"ps %cpu samples: mean {sum(samples) / max(1, len(samples)):.1f}% · max {max(samples) if samples else 0:.1f}% · n={len(samples)}")
print(f"bytes written to the pty: {(b1 - b0) / 1e6:.1f} MB ({(b1 - b0) / wall / 1e3:.0f} KB/s)")
