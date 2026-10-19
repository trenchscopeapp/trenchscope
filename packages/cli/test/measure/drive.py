#!/usr/bin/env python3
"""task-1304 QA pty driver (extends the task-1297 pty-drive.py).

usage: python3 -I drive.py --cwd REPO --out DIR --name NAME [--cols 176 --rows 48] [--env K=V ...]
         [--cpu] --keys "t:KEY,t:KEY,..." -- CMD ARGS...

KEY: ENTER ESC TAB STAB UP DOWN LEFT RIGHT PGDN PGUP BS SPACE CTRLC CTRLU
     SNAP:label        dump a frame, send nothing
     WAIT:text[@secs]  block until the live frame contains text (use _ for space) or secs (default 8)
                       elapse, then continue — makes a following SNAP deterministic under CPU load
                       (task-1319: fixed-offset SNAPs flaked when the app had not painted yet).
                       Time a WAIT spends past its own offset shifts every later event by the same
                       amount, so the gaps between later keys survive a slow paint (task-1410)
     TYPE:text         type text one char at a time (commas not allowed; use _ for space)
     RESIZE:WxH        TIOCSWINSZ + SIGWINCH
     SIGTERM / SIGHUP  signal the app
     or a single literal character
Writes NAME.raw, NAME.frames.txt (frame before every event + final), NAME.meta.txt.
Never echoes the environment.
"""
import os, pty, sys, time, fcntl, termios, struct, select, signal, re, subprocess

argv = sys.argv[1:]
def opt(k, d=None):
    if k in argv:
        i = argv.index(k); v = argv[i + 1]; del argv[i:i + 2]; return v
    return d
def flag(k):
    if k in argv: argv.remove(k); return True
    return False
cwd = opt('--cwd'); out_dir = opt('--out'); name = opt('--name', 'run')
cols = int(opt('--cols', '176')); rows = int(opt('--rows', '48'))
keys_spec = opt('--keys', '')
grace = float(opt('--grace', '15'))
cpu = flag('--cpu')
term = opt('--term', 'xterm-256color'); colorterm = opt('--colorterm', 'truecolor')
envs = []
while '--env' in argv: envs.append(opt('--env'))
cmd = argv[argv.index('--') + 1:]
os.makedirs(out_dir, exist_ok=True)

KEYS = {'ENTER': b'\r', 'ESC': b'\x1b', 'TAB': b'\t', 'STAB': b'\x1b[Z', 'UP': b'\x1b[A', 'DOWN': b'\x1b[B',
        'LEFT': b'\x1b[D', 'RIGHT': b'\x1b[C', 'PGDN': b'\x1b[6~', 'PGUP': b'\x1b[5~', 'BS': b'\x7f',
        'SPACE': b' ', 'CTRLC': b'\x03', 'CTRLU': b'\x15'}
events = []
for part in [p for p in keys_spec.split(',') if p]:
    t, k = part.split(':', 1)
    events.append((float(t), k))
events.sort(key=lambda e: e[0])

pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    if colorterm: os.environ['COLORTERM'] = colorterm
    else: os.environ.pop('COLORTERM', None)
    os.environ['TERM'] = term
    for e in envs:
        k, v = e.split('=', 1)
        if v == '__UNSET__': os.environ.pop(k, None)
        else: os.environ[k] = v
    os.execvp(cmd[0], cmd)

def setsize(c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
setsize(cols, rows)

grid = [[' '] * cols for _ in range(rows)]
cur = [0, 0]
pending = b''
CSI = re.compile(rb'\x1b\[([?0-9;]*)([A-Za-z@])')
def feed(data):
    global pending, grid
    buf = pending + data; i = 0
    while i < len(buf):
        b = buf[i]
        if b == 0x1b:
            m = CSI.match(buf, i)
            if m:
                params, final = m.group(1).decode(), m.group(2).decode()
                if final in 'Hf':
                    p = [int(x) if x else 1 for x in params.split(';')] if params else [1, 1]
                    r = (p[0] if p else 1) - 1; c = (p[1] if len(p) > 1 else 1) - 1
                    cur[0] = max(0, min(rows - 1, r)); cur[1] = max(0, min(cols - 1, c))
                elif final == 'J' and params in ('', '2'):
                    grid = [[' '] * cols for _ in range(rows)]
                elif final == 'K':
                    for c in range(cur[1], cols): grid[cur[0]][c] = ' '
                i = m.end(); continue
            if i + 1 >= len(buf) or buf[i + 1:i + 2] == b'[':
                pending = buf[i:]; return
            if buf[i + 1:i + 2] == b']':  # OSC ... BEL/ST
                j = buf.find(b'\x07', i)
                j2 = buf.find(b'\x1b\\', i)
                ends = [x for x in (j, j2) if x >= 0]
                if not ends: pending = buf[i:]; return
                e = min(ends); i = e + (1 if e == j else 2); continue
            i += 2; continue
        if b == 0x0d: cur[1] = 0; i += 1; continue
        if b == 0x0a: cur[0] = min(rows - 1, cur[0] + 1); i += 1; continue
        if b < 0x20: i += 1; continue
        n = 1 if b < 0x80 else 2 if b < 0xe0 else 3 if b < 0xf0 else 4
        if i + n > len(buf): pending = buf[i:]; return
        ch = buf[i:i + n].decode('utf-8', errors='replace'); i += n
        if ch in '​️' or (len(ch) == 1 and 0x300 <= ord(ch) <= 0x36f): continue
        if cur[1] < cols and cur[0] < rows: grid[cur[0]][cur[1]] = ch
        cur[1] += 1
    pending = b''

def frame_text():
    return '\n'.join(''.join(r).rstrip() for r in grid)

raw = open(os.path.join(out_dir, f'{name}.raw'), 'wb')
frames = open(os.path.join(out_dir, f'{name}.frames.txt'), 'w', encoding='utf-8')
total = 0; t0 = time.time(); ei = 0; alive = True; shift = 0.0
cpu_samples = []; last_cpu = 0.0
def drain(timeout):
    global total, alive
    r, _, _ = select.select([fd], [], [], timeout)
    if fd in r:
        try: data = os.read(fd, 65536)
        except OSError: alive = False; return
        if not data: alive = False; return
        total += len(data); raw.write(data); feed(data)

while alive:
    now = time.time() - t0
    if cpu and now - last_cpu >= 2.0:
        last_cpu = now
        try:
            v = subprocess.run(['ps', '-o', '%cpu=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()
            if v: cpu_samples.append((round(now, 1), float(v)))
        except Exception: pass
    if ei < len(events) and now >= events[ei][0] + shift:
        t, k = events[ei]; ei += 1
        frames.write(f'==== t={now:.1f}s before {k} ({cols}x{rows}) ====\n{frame_text()}\n\n')
        if k.startswith('SNAP:'): continue
        if k.startswith('WAIT:'):
            spec = k[5:]
            needle, _, secs = spec.partition('@')
            needle = needle.replace('_', ' ')
            limit = float(secs) if secs else 8.0
            deadline = time.time() + limit
            while alive and needle not in frame_text() and time.time() < deadline:
                drain(0.05)
            shift = max(shift, time.time() - t0 - t)
            continue
        if k.startswith('RESIZE:'):
            w, h = [int(x) for x in k[7:].split('x')]
            cols, rows = w, h
            grid = [[' '] * cols for _ in range(rows)]; cur[0] = cur[1] = 0
            setsize(cols, rows)
            try: os.kill(pid, signal.SIGWINCH)
            except ProcessLookupError: pass
            continue
        if k in ('SIGTERM', 'SIGHUP'):
            try: os.kill(pid, getattr(signal, k))
            except ProcessLookupError: pass
            continue
        if k.startswith('TYPE:'):
            for ch in k[5:].replace('_', ' '):
                os.write(fd, ch.encode()); drain(0.04)
            continue
        try: os.write(fd, KEYS.get(k, k.encode()))
        except OSError: alive = False
        continue
    nxt = (events[ei][0] + shift - now) if ei < len(events) else 0.5
    drain(max(0.01, min(0.5, nxt)))
    if ei >= len(events) and time.time() - t0 > (events[-1][0] if events else 0) + shift + grace:
        break
killed = False
if alive:
    killed = True
    os.kill(pid, signal.SIGKILL); drain(0.5)
_, status = os.waitpid(pid, 0)
raw.close()
frames.write(f'==== final (t={time.time()-t0:.1f}s, {cols}x{rows}) ====\n{frame_text()}\n')
frames.close()
data = open(os.path.join(out_dir, f'{name}.raw'), 'rb').read()
tail = data[-300:]
restored = b'\x1b[?1049l' in tail and b'\x1b[?25h' in tail
entered = b'\x1b[?1049h' in data[:2000]
code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -os.WTERMSIG(status)
after = data[data.rfind(b'\x1b[?1049l') + 8:] if b'\x1b[?1049l' in data else b''
meta = (f'cmd: {" ".join(cmd)}\nsize(final): {cols}x{rows}\nkeys: {keys_spec}\nexit: {code}\nkilled by driver: {killed}\n'
        f'bytes: {total}\nwall: {time.time()-t0:.1f}s\nentered alt screen: {entered}\nrestored at tail: {restored}\n'
        f'bytes after leaving alt screen: {after[:400]!r}\n')
if cpu_samples:
    meta += 'cpu samples (t, %cpu): ' + ' '.join(f'{t}:{c}' for t, c in cpu_samples) + '\n'
open(os.path.join(out_dir, f'{name}.meta.txt'), 'w').write(meta)
print(meta)
