// The interactive loop with effects, in-process on a fake TTY (same harness as guard.test.ts):
// first launch = full boot, any key skips it and still acts, the screen change blinks, the state
// file records the launch, the second launch boots short and lands on the screener by itself,
// `c` toggles calm, the fixture demo keys fire their toasts, and `q` restores the terminal.
// task-1319: this file once hung after `q` — before the quit fix the rate-limiter/fetch timers stayed
// ref'd and kept the in-process loop alive past quit(). The limiter.close()/fetch-abort fix resolved it;
// it now runs and exits clean (no quarantine, no --test-force-exit).
import { serialLane } from './lane.ts';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENTER_SCREEN, LEAVE_SCREEN, KATAKANA } from '@dexterm/tui';
import { main, type Io, type GuardProcess } from '../../src/main.ts';

const laneTest = serialLane(import.meta.url);
const KANA = new RegExp(`[${KATAKANA}]`);

function fakeTty(env: NodeJS.ProcessEnv) {
  let out = '';
  let err = '';
  let writes = 0;
  const rawCalls: boolean[] = [];
  const stdout = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); writes += 1; cb(); } }) as unknown as NodeJS.WriteStream & { fd: 1 };
  const stderr = new Writable({ write(chunk, _enc, cb) { err += chunk.toString(); cb(); } }) as unknown as NodeJS.WriteStream & { fd: 2 };
  Object.assign(stdout, { isTTY: true, columns: 140, rows: 40 });
  Object.assign(stderr, { isTTY: true });
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { fd: 0 };
  Object.assign(stdin, { isTTY: true, setRawMode(v: boolean) { rawCalls.push(v); return stdin; } });
  const io: Io = { stdout, stderr, stdin, env: { DEXTERM_OFFLINE: '1', COLORTERM: 'truecolor', ...env } };
  return { io, out: () => out, err: () => err, writes: () => writes, rawCalls, type: (s: string) => { (stdin as unknown as PassThrough).write(s); } };
}

function fakeProc() {
  const em = new EventEmitter();
  const exits: number[] = [];
  return { proc: Object.assign(em, { exit: (code?: number) => { exits.push(code ?? 0); } }) as unknown as GuardProcess & EventEmitter, exits };
}

async function until(cond: () => boolean, ms = 6000, what = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

laneTest('first launch: full boot, a key skips it and acts, blink, state recorded; second launch: short boot lands on the screener alone', {}, async () => {
  const home = mkdtempSync(join(tmpdir(), 'dexterm-loop-'));
  try {
    // ---- launch 1
    const t = fakeTty({ DEXTERM_HOME: home });
    const p = fakeProc();
    const run = main(['--fixtures', '--full', '--theme', 'cyberspace', '--intensity', 'fever', '--fps', '30'], t.io, p.proc);
    await until(() => t.out().includes(ENTER_SCREEN), 3000, 'alternate screen');
    await until(() => t.out().includes('JACKING IN'), 3000, 'the boot screen');
    assert.match(t.out(), KANA, 'the boot rains');
    assert.doesNotMatch(t.out(), /SCREENER/, 'still booting');
    t.type('2'); // first key skips the boot; a FIRST launch then shows the one-time welcome card (task-1305)
    await until(() => t.out().includes('WELCOME TO TRENCHSCOPE'), 4000, 'the one-time welcome card after the boot');
    assert.match(t.out(), /[▀▄]{20}/, 'the blink eyelids were drawn');
    const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
    assert.equal(saved.boots, 1, 'the launch was recorded when the boot ended');
    t.type('2'); // dismiss the welcome AND open new pairs in the same key (QA DEFECT 2)
    await until(() => t.out().includes('NEW PAIRS'), 4000, 'the new pairs screen after dismissing the welcome');
    // calm toggle: the header says so and the rain stops in later frames
    t.type('c');
    await until(() => t.out().includes('◉ live · calm'), 3000, 'calm header');
    const mark = t.out().length;
    await new Promise((r) => setTimeout(r, 700));
    assert.doesNotMatch(t.out().slice(mark), KANA, 'no rain while calm');
    t.type('c');
    // a demo event: pump toast, gold mood
    t.type('1');
    await until(() => t.out().includes('SCREENER'), 3000, 'screener');
    t.type('u');
    await until(() => t.out().includes('▲38% 5m · smart money in'), 3000, 'pump toast');
    t.type('n');
    await until(() => /new pair \$(WAGMI|JEET|NGMI|COPIUM|REKT)/.test(t.out()), 3000, 'new pair toast');
    t.type('q');
    assert.equal(await run, 0);
    assert.ok(t.out().endsWith(LEAVE_SCREEN));
    assert.deepEqual(t.rawCalls, [true, false]);
    assert.equal(t.err(), '');
    assert.deepEqual(p.exits, []);

    // ---- launch 2: short boot, no key pressed
    const t2 = fakeTty({ DEXTERM_HOME: home });
    const p2 = fakeProc();
    const t0 = Date.now();
    const run2 = main(['--fixtures', '--full', '--theme', 'cyberspace', '--intensity', 'fever', '--fps', '30'], t2.io, p2.proc);
    await until(() => t2.out().includes('JACKING IN'), 3000, 'short boot screen');
    await until(() => t2.out().includes('SCREENER'), 4000, 'screener after the short boot');
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 3500, `short boot took ${elapsed} ms`);
    assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).boots, 2);
    t2.type('q');
    assert.equal(await run2, 0);
    assert.ok(t2.out().endsWith(LEAVE_SCREEN));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

laneTest('--no-boot and --calm start straight on the screener without a transition; calm only draws on data ticks', {}, async () => {
  const home = mkdtempSync(join(tmpdir(), 'dexterm-loop-'));
  // Seed a prior launch so this is NOT a first run: a first run shows the one-time welcome card even
  // with --no-boot (task-1305), which is a different path. Here we want the bare "straight to the
  // screener, no transition" start, and to prove a skipped boot does not record a new launch.
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, boots: 1 }) + '\n');
  try {
    const t = fakeTty({ DEXTERM_HOME: home });
    const p = fakeProc();
    const run = main(['--fixtures', '--full', '--calm', '--no-boot'], t.io, p.proc);
    await until(() => t.out().includes('SCREENER'), 3000, 'screener');
    assert.doesNotMatch(t.out(), /JACKING IN/);
    assert.doesNotMatch(t.out(), /WELCOME TO TRENCHSCOPE/, 'a later launch skips the welcome card');
    assert.match(t.out(), /◉ live · calm/);
    // Count paints, not bytes: one paint is one write, and a data tick repaints every row whose price moved
    // (about 33 KB at 140x40 in the mono theme), so a byte bound broke whenever two ticks fell in the window.
    // Data ticks run at 2 Hz, so 1.2 s holds at most 3; an animating screen would write dozens.
    const w0 = t.writes();
    await new Promise((r) => setTimeout(r, 1200));
    const paints = t.writes() - w0;
    assert.ok(paints <= 3, `calm mode painted ${paints} times in 1.2 s (data ticks only: at most 3 at 2 Hz)`);
    assert.doesNotMatch(t.out(), KANA);
    t.type('q');
    assert.equal(await run, 0);
    // a skipped boot (--no-boot on a later launch) does not record a new launch: the count is unchanged
    assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).boots, 1, 'a skipped boot is not a recorded launch');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
