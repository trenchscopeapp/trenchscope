#!/usr/bin/env python3 -I
"""task-1329: measure the history recorder on the REAL interactive app (live keyless feeds) in a pty.

usage: python3 -I packages/recorder/tools/measure-live.py --seconds 300 [--no-recorder] [--calm] [--db PATH] [-- extra args]

Spawns `node packages/cli/bin/dexterm.mjs --no-boot --db <db> [--no-recorder] ...` on a 176x48 pty, drains the
output, samples the node process CPU (ps %cpu every 2 s, plus total cputime / wall), then quits with ESC+q.
Prints: CPU, DB file growth (bytes, extrapolated to MB per 8 h day), recorder stats (rows written, bytes/row),
and the request log summary when --verbose is passed through. Same method as cli/tools/cpu-measure.py.
"""
import os, pty, sys, time, fcntl, termios, struct, subprocess, threading, signal, tempfile, json

args = sys.argv[1:]
seconds = 300
cols, rows = 176, 48
db = None
def take(flag, conv=str, default=None):
    global args
    if flag in args:
        i = args.index(flag); v = conv(args[i + 1]); del args[i:i + 2]; return v
    return default
seconds = take('--seconds', int, seconds)
cols = take('--cols', int, cols)
rows = take('--rows', int, rows)
db = take('--db', str, None)
extra = args[args.index('--') + 1:] if '--' in args else args
here = os.path.dirname(os.path.abspath(__file__))
repo = os.path.dirname(os.path.dirname(os.path.dirname(here)))
home = tempfile.mkdtemp(prefix='dexterm-r01-home-')
if db is None:
    db = os.path.join(tempfile.mkdtemp(prefix='dexterm-r01-db-'), 'dexterm.db')
reqlog = os.path.join(home, 'requests.log')

def db_bytes():
    total = 0
    for suffix in ('', '-wal', '-shm'):
        try: total += os.path.getsize(db + suffix)
        except OSError: pass
    return total

b_start = db_bytes()
pid, fd = pty.fork()
if pid == 0:
    os.chdir(repo)
    os.environ['COLORTERM'] = 'truecolor'
    os.environ['DEXTERM_HOME'] = home
    os.environ.pop('DEXTERM_OFFLINE', None)
    err = os.open(reqlog, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.dup2(err, 2)
    os.execvp('node', ['node', 'packages/cli/bin/dexterm.mjs', '--no-boot', '--db', db, *extra])

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

def recorder_bytes():
    """dbstat sum over the recorder's own tables/indexes via `dexterm recorder stats` (WAL: concurrent read is fine)."""
    out = subprocess.run(['node', 'packages/cli/bin/dexterm.mjs', 'recorder', 'stats', '--db', db], cwd=repo, capture_output=True, text=True).stdout
    for line in out.splitlines():
        if line.startswith('recorder bytes'):
            try: return int(line.split()[2])
            except ValueError: return None
    return None

time.sleep(5.0)  # let the first paint + first refresh land before the window starts
t0 = time.time(); c0 = cputime(); b0 = db_bytes(); r0 = recorder_bytes()
samples = []
while time.time() - t0 < seconds:
    time.sleep(2.0)
    out = subprocess.run(['ps', '-o', '%cpu=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()
    try:
        samples.append(float(out))
    except ValueError:
        pass
t1 = time.time(); c1 = cputime(); b1 = db_bytes(); r1 = recorder_bytes()
os.write(fd, b'\x1b'); time.sleep(0.3); os.write(fd, b'q')
for _ in range(50):
    time.sleep(0.1)
    try:
        if os.waitpid(pid, os.WNOHANG)[0] == pid: break
    except ChildProcessError:
        break
else:
    try: os.kill(pid, signal.SIGKILL)
    except ProcessLookupError: pass
wall = t1 - t0
b_end = db_bytes()
print(f"args: {' '.join(extra) or '(default)'}  ·  {cols}x{rows} pty  ·  db {db}")
print(f"wall {wall:.1f}s · cpu time {c1 - c0:.1f}s → {100 * (c1 - c0) / wall:.2f}% of one core")
print(f"ps %cpu samples: mean {sum(samples) / max(1, len(samples)):.1f}% · max {max(samples) if samples else 0:.1f}% · n={len(samples)}")
print(f"pty bytes: {(b1 - b0) / 1e6:.1f} MB")
print(f"db bytes (file+wal+shm): start {b_start} · window start {b0} · window end {b1} · after quit {b_end}")
growth = b1 - b0
print(f"db file growth in window (cache + WAL churn included): {growth / 1e6:.2f} MB over {wall / 60:.1f} min")
if r0 is not None and r1 is not None:
    rg = r1 - r0
    print(f"RECORDER bytes (dbstat, own tables + indexes): {r0} → {r1} = {rg / 1e6:.2f} MB in {wall / 60:.1f} min → {rg / wall * 3600 * 8 / 1e6:.1f} MB per 8 h day (linear extrapolation)")
stats = subprocess.run(['node', 'packages/cli/bin/dexterm.mjs', 'recorder', 'stats', '--db', db], cwd=repo, capture_output=True, text=True)
print(stats.stdout.strip() or stats.stderr.strip())
try:
    with open(reqlog) as f:
        lines = f.read().splitlines()
    rec = [l for l in lines if l.startswith('recorder:')]
    req = [l for l in lines if l.startswith('  ') and 'ms ' in l]
    print(f"stderr: {len(req)} request lines, {len(rec)} recorder lines")
    for l in rec[-8:]:
        print('  ' + l)
    by = {}
    for l in req:
        src = l.split()[0]
        by[src] = by.get(src, 0) + 1
    if by:
        print('  requests by source: ' + ', '.join(f'{k} {v}' for k, v in sorted(by.items())) + f'  ({len(req) / max(1, wall) * 60:.1f} req/min overall)')
    sweeps = [l for l in req if 'tokens/v1' in l]
    print(f"  dexscreener tokens/v1 calls: {len(sweeps)}")
except OSError:
    pass
