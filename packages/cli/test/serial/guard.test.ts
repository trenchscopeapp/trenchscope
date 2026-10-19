// Terminal restore guard (task-1279 verification fix): whatever ends the interactive loop, the
// terminal must come back in cooked mode, cursor shown, main screen restored. Covered three ways:
// the guard on a mocked stdout + fake process, the whole loop in-process through main() with a fake
// TTY, and (when python3 is present) the real binary inside a pty with the verifier's exact repro.
// task-1319: this file once hung after `q` — before the quit fix the rate-limiter/fetch timers stayed
// ref'd and kept the in-process loop alive past quit(). The limiter.close()/fetch-abort fix resolved it;
// it now runs and exits clean (no quarantine, no --test-force-exit).
// task-1424: the whole file runs in the serial lane (real timers, the interactive loop and a real pty).
import { serialLane } from './lane.ts';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENTER_SCREEN, LEAVE_SCREEN, THEMES } from '@dexterm/tui';
import { terminalGuard, describeError, main, interactive, parseArgs, type Io, type GuardProcess } from '../../src/main.ts';
import { makeFixtureState } from '../../src/state.ts';

const laneTest = serialLane(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(here, '..', '..', 'bin', 'dexterm.mjs');
// launches must never touch the real ~/.dexterm/state.json
const HOME = mkdtempSync(join(tmpdir(), 'dexterm-home-'));
// These tests exercise the restore guard, not onboarding: seed a prior launch so no run is a FIRST
// launch, i.e. no one-time welcome card sits in front of the keys (task-1305 added that card after
// these tests were written, and it swallows the first post-boot key — and then even `q`).
writeFileSync(join(HOME, 'state.json'), JSON.stringify({ version: 1, boots: 3 }) + '\n');

function fakeTty() {
  let out = '';
  let err = '';
  const rawCalls: boolean[] = [];
  const stdout = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } }) as unknown as NodeJS.WriteStream & { fd: 1 };
  const stderr = new Writable({ write(chunk, _enc, cb) { err += chunk.toString(); cb(); } }) as unknown as NodeJS.WriteStream & { fd: 2 };
  Object.assign(stdout, { isTTY: true, columns: 120, rows: 36 });
  Object.assign(stderr, { isTTY: true });
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { fd: 0 };
  Object.assign(stdin, { isTTY: true, setRawMode(v: boolean) { rawCalls.push(v); return stdin; } });
  const io: Io = { stdout, stderr, stdin, env: { DEXTERM_OFFLINE: '1', DEXTERM_HOME: HOME } };
  return { io, out: () => out, err: () => err, rawCalls, type: (s: string) => { (stdin as unknown as PassThrough).write(s); } };
}

function fakeProc() {
  const em = new EventEmitter();
  const exits: number[] = [];
  const proc = Object.assign(em, { exit: (code?: number) => { exits.push(code ?? 0); } }) as unknown as GuardProcess & EventEmitter;
  return { proc, exits, listeners: () => ['exit', 'uncaughtException', 'unhandledRejection', 'SIGTERM', 'SIGHUP'].reduce((n, e) => n + em.listenerCount(e), 0) };
}

const settle = () => new Promise<void>((r) => setImmediate(r));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

laneTest('terminalGuard: an uncaught exception restores cooked mode, cursor and main screen, then exits 1', {}, () => {
  const t = fakeTty();
  const p = fakeProc();
  const fatals: unknown[] = [];
  const g = terminalGuard(t.io, (e) => fatals.push(e), p.proc);
  g.install();
  assert.equal(p.listeners(), 5);
  t.io.stdout.write(ENTER_SCREEN);
  p.proc.emit('uncaughtException', new TypeError('p is not a function'));
  assert.ok(g.restored);
  assert.ok(t.out().endsWith(LEAVE_SCREEN), 'LEAVE_SCREEN written last');
  assert.match(LEAVE_SCREEN, /\x1b\[\?25h/, 'cursor shown');
  assert.match(LEAVE_SCREEN, /\x1b\[\?1049l/, 'alternate screen left');
  assert.deepEqual(t.rawCalls, [false], 'cooked mode');
  assert.match(t.err(), /dexterm: fatal: TypeError: p is not a function/);
  assert.deepEqual(p.exits, [1]);
  assert.deepEqual(fatals.map(describeError), ['TypeError: p is not a function']);
  // restore is idempotent: the exit hook that follows must not write a second LEAVE_SCREEN
  const before = t.out();
  p.proc.emit('exit', 1);
  g.restore();
  assert.equal(t.out(), before);
  assert.deepEqual(t.rawCalls, [false]);
  g.uninstall();
  assert.equal(p.listeners(), 0);
});

laneTest('terminalGuard: unhandled rejections, SIGTERM, SIGHUP and plain exit all restore; restore never throws', {}, () => {
  for (const [event, arg, code] of [['unhandledRejection', new Error('late'), 1], ['SIGTERM', undefined, 143], ['SIGHUP', undefined, 129], ['exit', 0, undefined]] as const) {
    const t = fakeTty();
    const p = fakeProc();
    const g = terminalGuard(t.io, undefined, p.proc);
    g.install();
    p.proc.emit(event, arg);
    assert.ok(g.restored, event);
    assert.ok(t.out().endsWith(LEAVE_SCREEN), `${event}: LEAVE_SCREEN`);
    assert.deepEqual(t.rawCalls, [false], event);
    assert.deepEqual(p.exits, code === undefined ? [] : [code], event);
    g.uninstall();
  }
  // a dead stdout / stdin must not turn the restore itself into a second crash
  const broken = fakeTty();
  (broken.io.stdout as unknown as { write: () => never }).write = () => { throw new Error('EPIPE'); };
  (broken.io.stdin as unknown as { setRawMode: () => never }).setRawMode = () => { throw new Error('EBADF'); };
  const g = terminalGuard(broken.io, undefined, fakeProc().proc);
  assert.doesNotThrow(() => g.restore());
  assert.ok(g.restored);
  // non-TTY stdin: no setRawMode call at all
  const pipe = fakeTty();
  Object.assign(pipe.io.stdin, { isTTY: false });
  terminalGuard(pipe.io, undefined, fakeProc().proc).restore();
  assert.deepEqual(pipe.rawCalls, []);
});

laneTest('TUI in-process: / __proto__:yes enter shows the grammar error and the loop keeps running; q leaves the screen cleanly', {}, async () => {
  const t = fakeTty();
  const p = fakeProc();
  const run = main(['--fixtures'], t.io, p.proc);
  let settled: number | null = null;
  void run.then((c) => { settled = c; });
  try {
    await until(() => t.out().includes(ENTER_SCREEN));
    assert.equal(p.listeners(), 5, 'process guards installed while interactive');
    t.type('/');
    await until(() => t.out().includes('type a filter'));
    for (const ch of '__proto__:yes') t.type(ch);
    t.type('\r');
    await until(() => t.out().includes('✗ unknown tag "__proto__:"'));
    await settle();
    assert.equal(settled, null, 'still running after enter');
    assert.ok(!t.out().includes(LEAVE_SCREEN), 'screen not left');
    assert.deepEqual(t.rawCalls, [true]);
    // editor still open, text intact; esc closes it
    t.type('\x1b');
    await settle();
    assert.equal(settled, null);
    // the other two verifier spellings through the same path
    for (const src of ['constructor:true', '!__proto__:no']) {
      t.type('/');
      t.type('\x15');
      for (const ch of src) t.type(ch);
      t.type('\r');
      await until(() => t.out().includes(src.replace(/^!/, '').split(':')[0] + ':"'));
      t.type('\x1b');
      await settle();
      assert.equal(settled, null, `${src}: still running`);
    }
  } finally {
    t.type('q');
  }
  assert.equal(await run, 0);
  assert.ok(t.out().endsWith(LEAVE_SCREEN), 'LEAVE_SCREEN is the last thing written');
  assert.deepEqual(t.rawCalls, [true, false]);
  assert.equal(p.listeners(), 0, 'process guards removed on quit');
  assert.deepEqual(p.exits, []);
  assert.equal(t.err(), '');
});

laneTest('TUI in-process: a key handler or render exception is shown as a notice, the loop survives, q still restores', {}, async () => {
  const t = fakeTty();
  const p = fakeProc();
  const state = makeFixtureState({ screen: 'screener', theme: THEMES.midnight });
  const boom = () => { throw new TypeError('p is not a function'); };
  const run = interactive(state, t.io, 'none', parseArgs(['--fixtures']), p.proc);
  let settled: number | null = null;
  void run.then((c) => { settled = c; });
  try {
    await until(() => t.out().includes(ENTER_SCREEN));
    // a poisoned predicate: every path that evaluates the view now throws (clampSelection in applyKey and the renderer)
    state.screener.filter = { text: 'poison', clauses: [], predicate: boom };
    (state.screener.filter as { clauses: unknown[] }).clauses = [{ kind: 'text', value: 'x', raw: 'x' }];
    t.type('j');
    await until(() => state.screener.notice !== null);
    assert.match(state.screener.notice ?? '', /⚠ key "j" failed: TypeError: p is not a function/);
    await until(() => t.out().includes('dexterm: render error: TypeError: p is not a function'));
    await settle();
    assert.equal(settled, null, 'still running after a throwing key and a throwing render');
    assert.ok(!t.out().includes(LEAVE_SCREEN));
    // heal the state: the next tick draws a real frame again with the notice in the filter bar
    state.screener.filter = null;
    await until(() => t.out().includes('⚠ key "j" failed'));
    // and the loop still takes keys (an action key clears the transient notice)
    t.type('k');
    await until(() => state.screener.notice === null);
  } finally {
    t.type('q');
  }
  assert.equal(await run, 0);
  assert.ok(t.out().endsWith(LEAVE_SCREEN));
  assert.deepEqual(t.rawCalls, [true, false]);
  assert.equal(p.listeners(), 0);
  assert.equal(t.err(), '');
});

// ---------------------------------------------------------------------------------------------
// real pty (python3's pty module drives the actual binary; skipped where python3 is missing)

const PY = `
import fcntl, json, os, pty, select, signal, struct, sys, termios, time
bin_path, mode, home = sys.argv[1], sys.argv[2], sys.argv[3]
ENTER = "\\x1b[?1049h"; LEAVE = "\\x1b[?1049l"
pid, fd = pty.fork()
if pid == 0:
    os.environ["DEXTERM_OFFLINE"] = "1"; os.environ["TERM"] = "xterm-256color"; os.environ["DEXTERM_HOME"] = home
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 120, 0, 0))
    os.execvp("node", ["node", bin_path, "--fixtures", "--tz", "UTC"])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 120, 0, 0))
buf = b""
def send(data):
    try: os.write(fd, data)
    except OSError: pass   # child already gone: the report below says so
def pump(timeout):
    global buf
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try: buf += os.read(fd, 65536)
            except OSError: return
def wait_for(needle, timeout=15):
    end = time.time() + timeout
    while needle.encode() not in buf and time.time() < end: pump(0.1)
    return needle.encode() in buf
reaped = {"status": None}
def alive():
    if reaped["status"] is not None: return False
    p, st = os.waitpid(pid, os.WNOHANG)
    if p == 0: return True
    reaped["status"] = st; return False
got_enter = wait_for(ENTER)
alive_after_enter = alive()
result = {"got_enter": got_enter, "alive_after_enter": alive_after_enter}
if mode == "proto":
    send(b"/"); pump(0.4)
    for ch in "__proto__:yes": send(ch.encode()); pump(0.03)
    send(b"\\r"); pump(1.0)
    result["error_shown"] = b'unknown tag "__proto__:"' in buf
    result["alive_after_proto"] = alive()
    send(b"\\x1b"); pump(0.3)
    send(b"q"); pump(1.0)
else:
    os.kill(pid, signal.SIGTERM); pump(1.5)
end = time.time() + 10
while alive() and time.time() < end: pump(0.1)
if alive():
    os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0); reaped["status"] = -1
pump(0.3)
status = reaped["status"]
result["leave_after_enter"] = buf.rfind(LEAVE.encode()) > buf.find(ENTER.encode())
result["exit_code"] = (os.WEXITSTATUS(status) if status != -1 and os.WIFEXITED(status) else None)
result["signaled"] = (os.WTERMSIG(status) if status != -1 and os.WIFSIGNALED(status) else None)
result["bytes"] = len(buf)
print(json.dumps(result))
`;

const hasPython = (() => { try { execFileSync('python3', ['-c', 'import pty'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function pty(mode: 'proto' | 'sigterm') {
  const r = spawnSync('python3', ['-I', '-c', PY, BIN, mode, HOME], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, `python pty driver failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>;
}

laneTest('pty: the real binary survives / __proto__:yes enter, shows the error, and q leaves the alternate screen', { skip: !hasPython && 'python3 with pty not available' }, () => {
  const r = pty('proto');
  assert.equal(r.got_enter, true, JSON.stringify(r));
  assert.equal(r.alive_after_enter, true, JSON.stringify(r));
  assert.equal(r.error_shown, true, JSON.stringify(r));
  assert.equal(r.alive_after_proto, true, `process died on the hostile filter: ${JSON.stringify(r)}`);
  assert.equal(r.leave_after_enter, true, `alternate screen not left: ${JSON.stringify(r)}`);
  assert.equal(r.exit_code, 0, JSON.stringify(r));
});

laneTest('pty: SIGTERM while in the alternate screen still restores the terminal (exit 143)', { skip: !hasPython && 'python3 with pty not available' }, () => {
  const r = pty('sigterm');
  assert.equal(r.got_enter, true, JSON.stringify(r));
  assert.equal(r.leave_after_enter, true, `alternate screen not left on SIGTERM: ${JSON.stringify(r)}`);
  assert.equal(r.exit_code, 143, JSON.stringify(r));
});
