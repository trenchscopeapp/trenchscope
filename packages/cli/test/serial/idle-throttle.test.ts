// task-1319 AC3 follow-up: the idle throttle. The full (fever) look paints at the frame cap while the user
// is active; after KEY_WAKE_S without a key (and nothing event-driven live) it strides down to IDLE_FPS,
// and the next key lifts the throttle instantly. Two layers:
//   1. shouldDrawFrame — the pure per-frame gate the loop uses.
//   2. the real interactive loop on a fake TTY (fixtures, paused so the demo events cannot wake it):
//      paints per second idle vs the first second after a key.
import { serialLane } from './lane.ts';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENTER_SCREEN } from '@dexterm/tui';
import { main, shouldDrawFrame, IDLE_FPS, KEY_WAKE_S, type Io, type GuardProcess, type FrameGate } from '../../src/main.ts';

const laneTest = serialLane(import.meta.url);
const base: FrameGate = { calm: false, transition: false, onTick: false, aiLive: false, awake: false, fxBusy: false, frame: 1, idleEvery: 4 };

laneTest('shouldDrawFrame: full rate while awake / blinking / streaming / event-busy; idle stride otherwise', {}, () => {
  // idle (fever): only every idleEvery-th frame
  const idlePaints = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((frame) => shouldDrawFrame({ ...base, frame }));
  assert.deepEqual(idlePaints, [0, 4, 8]);
  // a 2 Hz data tick on its own does not force an extra paint when idle (the stride already covers it)
  assert.equal(shouldDrawFrame({ ...base, frame: 15, onTick: true }), false);
  // anything live paints every frame
  for (const frame of [1, 2, 3, 5]) {
    assert.equal(shouldDrawFrame({ ...base, frame, awake: true }), true, 'awake');
    assert.equal(shouldDrawFrame({ ...base, frame, transition: true }), true, 'transition');
    assert.equal(shouldDrawFrame({ ...base, frame, aiLive: true }), true, 'ai streaming');
    assert.equal(shouldDrawFrame({ ...base, frame, fxBusy: true }), true, 'event animation');
  }
  // calm: data ticks (and wakes / blinks / streaming) only — never the ambient stride, never fxBusy
  assert.equal(shouldDrawFrame({ ...base, calm: true, frame: 4 }), false);
  assert.equal(shouldDrawFrame({ ...base, calm: true, frame: 4, fxBusy: true }), false);
  assert.equal(shouldDrawFrame({ ...base, calm: true, frame: 15, onTick: true }), true);
  assert.equal(shouldDrawFrame({ ...base, calm: true, frame: 1, awake: true }), true);
  assert.equal(shouldDrawFrame({ ...base, calm: true, frame: 1, transition: true }), true);
});

function fakeTty(env: NodeJS.ProcessEnv) {
  let out = '';
  const stdout = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } }) as unknown as NodeJS.WriteStream & { fd: 1 };
  const stderr = new Writable({ write(_chunk, _enc, cb) { cb(); } }) as unknown as NodeJS.WriteStream & { fd: 2 };
  Object.assign(stdout, { isTTY: true, columns: 140, rows: 40 });
  Object.assign(stderr, { isTTY: true });
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { fd: 0 };
  Object.assign(stdin, { isTTY: true, setRawMode() { return stdin; } });
  const io: Io = { stdout, stderr, stdin, env: { DEXTERM_OFFLINE: '1', COLORTERM: 'truecolor', ...env } };
  return { io, out: () => out, type: (s: string) => { (stdin as unknown as PassThrough).write(s); } };
}

function fakeProc() {
  const em = new EventEmitter();
  return Object.assign(em, { exit: () => {} }) as unknown as GuardProcess & EventEmitter;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}
/** Every non-empty paint is prefixed by the hide-cursor sequence exactly once (Flusher.diff). */
const paints = (s: string): number => s.split('\x1b[?25l').length - 1;

laneTest(`interactive loop (fever, fixtures, paused): ~${IDLE_FPS} paints/s after ${KEY_WAKE_S} s idle, full rate the second after a key`, {}, async () => {
  const home = mkdtempSync(join(tmpdir(), 'dexterm-idle-'));
  try {
    const t = fakeTty({ DEXTERM_HOME: home });
    const run = main(['--fixtures', '--no-boot', '--intensity', 'fever', '--fps', '30'], t.io, fakeProc());
    await until(() => t.out().includes(ENTER_SCREEN), 3000, 'alternate screen');
    await sleep(300);
    t.type('x'); // first launch shows the welcome card; any key dismisses it
    await sleep(200);
    t.type('p'); // pause the fixture demo: its random newpair/rug events would otherwise wake the loop
    // The key wake window is KEY_WAKE_S; wait it out plus a margin, then sample 2 s of idle.
    await sleep(KEY_WAKE_S * 1000 + 1200);
    const idle0 = paints(t.out());
    await sleep(2000);
    const idlePerSec = (paints(t.out()) - idle0) / 2;
    // A key lifts the throttle at once: the following second paints at (close to) the 30 fps cap.
    t.type('j');
    await sleep(50);
    const wake0 = paints(t.out());
    await sleep(1000);
    const wakePerSec = paints(t.out()) - wake0;
    t.type('q');
    assert.equal(await run, 0);
    // idle: alive (≥ 4/s) but throttled (≤ IDLE_FPS + 4 to absorb timer jitter and a late data tick)
    assert.ok(idlePerSec >= 4 && idlePerSec <= IDLE_FPS + 4, `idle paints/s = ${idlePerSec} (expected ~${IDLE_FPS})`);
    // active: at least double the idle rate and ≥ 18/s (the cap is 30; the box may be loaded)
    assert.ok(wakePerSec >= 18 && wakePerSec >= 2 * idlePerSec, `paints in the second after a key = ${wakePerSec} (expected ~30)`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
