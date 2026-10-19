// task-1325: docking the chart window beside the terminal. Pure placement math + the probe protocol, driven by
// a FAKE osascript (no Apple Events are ever sent from tests — from outside a terminal that would raise a
// macOS Automation consent dialog).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { detectTerminal, controllingTty, dockScript, parseDockProbe, dockRect, TerminalDock, type DockScreen } from '../src/dock.ts';
import { normalizeConfig, DEFAULT_HOTKEY_CLOSE } from '../src/config.ts';

const SCREEN: DockScreen = { frame: { x: 0, y: 0, w: 1920, h: 1080 }, visible: { x: 0, y: 25, w: 1920, h: 976 }, scale: 2 };
const SECOND: DockScreen = { frame: { x: 1920, y: 0, w: 1440, h: 900 }, visible: { x: 1920, y: 0, w: 1440, h: 900 }, scale: 1 };

test('detectTerminal: TERM_PROGRAM, then LC_TERMINAL (survives tmux/ssh), else unknown', () => {
  assert.equal(detectTerminal({ TERM_PROGRAM: 'Apple_Terminal' }), 'terminal');
  assert.equal(detectTerminal({ TERM_PROGRAM: 'iTerm.app' }), 'iterm');
  assert.equal(detectTerminal({ TERM_PROGRAM: 'tmux', LC_TERMINAL: 'iTerm2' }), 'iterm');
  for (const tp of ['WezTerm', 'ghostty', 'vscode', 'tmux', '', undefined]) assert.equal(detectTerminal({ TERM_PROGRAM: tp }), 'unknown');
});

test('controllingTty: ps output → /dev/ttysNNN; "??"/junk → null', () => {
  const fake = (out: string) => (() => ({ stdout: out })) as never;
  assert.equal(controllingTty(1, fake('ttys003\n')), '/dev/ttys003');
  assert.equal(controllingTty(1, fake('??\n')), null);
  assert.equal(controllingTty(1, fake('ttys003; rm -rf /')), null);
});

test('dockScript: tty and kind are JSON-encoded (no raw interpolation); follow/interval clamped', () => {
  const s = dockScript('terminal', '/dev/ttys003"); doEvil("', true, 0.01);
  assert.ok(s.includes('TTY = "/dev/ttys003\\"); doEvil(\\""'), 'quotes escaped by JSON.stringify');
  assert.match(s, /FOLLOW = true, EVERY = 0\.25;/);
  assert.match(dockScript('unknown', null, false), /KIND = "unknown", TTY = null, FOLLOW = false, EVERY = 0\.5;/);
  assert.match(s, /\$\.getppid\(\)/, 'the loop exits when the TUI is gone');
  assert.match(s, /com\.apple\.Terminal/); assert.match(s, /com\.googlecode\.iterm2/);
});

test('parseDockProbe: validates shape; junk → null', () => {
  const ok = parseDockProbe(JSON.stringify({ screens: [{ frame: [0, 0, 1920, 1080], visible: [0, 25, 1920, 976], scale: 2 }], term: [100, 50, 900, 700], pending: false }))!;
  assert.deepEqual(ok.term, { x: 100, y: 50, w: 900, h: 700 });
  assert.equal(ok.screens[0].visible.y, 25);
  assert.equal(parseDockProbe(JSON.stringify({ screens: [{ frame: [0, 0, 1920, 1080], visible: [0, 25, 1920, 976] }], term: null, pending: true }))!.pending, true);
  for (const bad of ['', 'nope', '{}', '{"screens":[]}', '{"screens":[{"frame":[0,0,"a",1],"visible":[0,0,1,1]}]}', '{"screens":[{"frame":[0,0,-5,1],"visible":[0,0,1,1]}]}']) assert.equal(parseDockProbe(bad), null, bad);
  assert.equal(parseDockProbe(JSON.stringify({ screens: [{ frame: [0, 0, 1, 1], visible: [0, 0, 1, 1] }], term: [1, 2, 'x', 4] }))!.term, null, 'bad term rect → treated as not found');
});

test('dockRect: right edge, same top + height; narrower when 360..width fits; left when the right is full', () => {
  const r = dockRect({ x: 100, y: 60, w: 1000, h: 800 }, [SCREEN], 'terminal');
  assert.deepEqual(r, { rect: { x: 1104, y: 60, w: 560, h: 800 }, mode: 'right', ontop: false, kind: 'terminal' });
  const narrow = dockRect({ x: 100, y: 60, w: 1300, h: 800 }, [SCREEN], 'terminal');
  assert.equal(narrow.mode, 'right'); assert.equal(narrow.rect.w, 1920 - 1400 - 4);
  const left = dockRect({ x: 700, y: 60, w: 1220, h: 800 }, [SCREEN], 'iterm');
  assert.deepEqual(left.rect, { x: 700 - 4 - 560, y: 60, w: 560, h: 800 }); assert.equal(left.mode, 'left');
});

test('dockRect: full-screen terminal → overlap at the screen edge, always-on-top; height/top clamped to the visible frame', () => {
  const o = dockRect({ x: 0, y: 0, w: 1920, h: 1080 }, [SCREEN], 'terminal');
  assert.equal(o.mode, 'overlap'); assert.equal(o.ontop, true);
  assert.deepEqual(o.rect, { x: 1360, y: 25, w: 560, h: 976 });
});

test('dockRect: the terminal on a second display docks on THAT display; unknown terminal → main screen right', () => {
  const r = dockRect({ x: 2000, y: 100, w: 700, h: 600 }, [SCREEN, SECOND], 'terminal');
  assert.equal(r.mode, 'right'); assert.equal(r.rect.x, 2704); assert.ok(r.rect.x + r.rect.w <= 1920 + 1440);
  const u = dockRect(null, [SCREEN], 'unknown');
  assert.deepEqual(u, { rect: { x: 1360, y: 25, w: 560, h: 976 }, mode: 'screen-right', ontop: true, kind: 'unknown' });
  assert.equal(dockRect(null, [SCREEN], 'unknown', { width: 5000 }).rect.w, 960, 'never wider than half the screen');
});

/** A fake osascript: emits the given stdout lines (with delays) and records kills. */
function fakeSpawn(lines: Array<[number, string]>, rec: { args: string[][]; kills: string[] }) {
  return (_cmd: string, args: string[]): ChildProcess => {
    rec.args.push(args);
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdout = new PassThrough();
    Object.assign(child, { stdout, pid: 4242, kill: (sig: string) => { rec.kills.push(sig); setImmediate(() => child.emit('exit', null, sig)); return true; } });
    for (const [ms, l] of lines) setTimeout(() => stdout.write(l + '\n'), ms);
    return child;
  };
}
const SC = { screens: [{ frame: [0, 0, 1920, 1080], visible: [0, 25, 1920, 976], scale: 2 }] };

test('TerminalDock.place: pending screens line then the terminal line → docked right; probe killed after', async () => {
  const rec = { args: [] as string[][], kills: [] as string[] };
  const d = new TerminalDock({ env: { TERM_PROGRAM: 'Apple_Terminal' }, platform: 'darwin', tty: '/dev/ttys009', spawnImpl: fakeSpawn([[5, JSON.stringify({ ...SC, term: null, pending: true })], [20, JSON.stringify({ ...SC, term: [100, 60, 1000, 800], pending: false })]], rec) });
  const p = await d.place(1000);
  assert.equal(p?.mode, 'right'); assert.equal(p?.kind, 'terminal');
  assert.deepEqual(rec.args[0].slice(0, 3), ['-l', 'JavaScript', '-e']);
  assert.match(rec.args[0][3], /TTY = "\/dev\/ttys009"/);
  assert.ok(rec.kills.length >= 1);
});

test('TerminalDock.place: terminal never answers (consent prompt / busy) → screen-right from the screens line at the timeout', async () => {
  const rec = { args: [] as string[][], kills: [] as string[] };
  const d = new TerminalDock({ env: { TERM_PROGRAM: 'Apple_Terminal' }, platform: 'darwin', tty: null, spawnImpl: fakeSpawn([[5, JSON.stringify({ ...SC, term: null, pending: true })]], rec) });
  const t = Date.now();
  const p = await d.place(150);
  assert.ok(Date.now() - t >= 140);
  assert.equal(p?.mode, 'screen-right');
});

test('TerminalDock: off macOS → null, never spawns', async () => {
  const rec = { args: [] as string[][], kills: [] as string[] };
  const d = new TerminalDock({ env: { TERM_PROGRAM: 'Apple_Terminal' }, platform: 'linux', tty: null, spawnImpl: fakeSpawn([], rec) });
  assert.equal(await d.place(50), null);
  d.follow(() => assert.fail('no follow off macOS'));
  assert.equal(rec.args.length, 0);
});

test('TerminalDock.follow: fires only on a changed placement, ignores pending/missing-terminal lines, stop() kills the loop', async () => {
  const rec = { args: [] as string[][], kills: [] as string[] };
  const line = (term: number[] | null, pending = false) => JSON.stringify({ ...SC, term, pending });
  const d = new TerminalDock({ env: { TERM_PROGRAM: 'iTerm.app' }, platform: 'darwin', tty: '/dev/ttys001', spawnImpl: fakeSpawn([
    [5, line(null, true)], [10, line([100, 60, 1000, 800])], [15, line([100, 60, 1000, 800])], [20, 'garbage'], [25, line(null)], [30, line([200, 80, 900, 700])],
  ], rec) });
  const seen: number[] = [];
  d.follow((p) => seen.push(p.rect.x));
  d.follow(() => assert.fail('idempotent: a second follow is a no-op'));
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(seen, [1104, 1104], 'first placement + the moved terminal; duplicates/pending/garbage/null ignored');
  assert.equal(rec.args.length, 1);
  assert.equal(d.following, true);
  d.stop();
  assert.deepEqual(rec.kills, ['SIGTERM']);
  assert.equal(d.following, false);
});

test('config: hotkeyClose + dock options normalised; junk → defaults', () => {
  const c = normalizeConfig({ hotkeyClose: 'Control+Alt+KeyQ', dock: { enabled: false, width: 99999, follow: false, followEvery: 0.01 } });
  assert.equal(c.hotkeyClose, 'Control+Alt+KeyQ');
  assert.deepEqual(c.dock, { enabled: false, width: 1600, follow: false, followEvery: 0.25 });
  const d = normalizeConfig({ hotkeyClose: '$(rm -rf /)', dock: 'yes' });
  assert.equal(d.hotkeyClose, DEFAULT_HOTKEY_CLOSE);
  assert.deepEqual(d.dock, { enabled: true, width: 560, follow: true, followEvery: 0.5 });
  assert.equal(normalizeConfig({ hotkeyClose: '' }).hotkeyClose, '', 'empty disables the close chord');
});
