import assert from 'node:assert/strict';
import { Writable, Readable } from 'node:stream';
import { test } from 'node:test';
import { DEFAULT_KEYMAP, parseKeys, THEMES } from '@dexterm/tui';
import type { PopupManager } from '@dexterm/popup';
import { main } from '../src/main.ts';
import { chartVMFromView, tokenDetailVMFromView, popupThemeFrom, TokenPopups } from '../src/popup.ts';
import { emptyView } from '../src/live/token.ts';

function fakeIo(env: NodeJS.ProcessEnv = {}) {
  let out = '', err = '';
  const stdout = new Writable({ write(c, _e, cb) { out += c.toString(); cb(); } }) as unknown as NodeJS.WriteStream & { fd: 1 };
  const stderr = new Writable({ write(c, _e, cb) { err += c.toString(); cb(); } }) as unknown as NodeJS.WriteStream & { fd: 2 };
  const stdin = new Readable({ read() {} }) as unknown as NodeJS.ReadStream & { fd: 0 };
  Object.assign(stdout, { isTTY: false, columns: 120, rows: 40 });
  return { io: { stdout, stderr, stdin, env }, out: () => out, err: () => err };
}

test('keymap: C on the token screen opens the chart popup (P stays global positions)', () => {
  const [cKey] = parseKeys('C');
  assert.equal(DEFAULT_KEYMAP.resolve(cKey, 'token'), 'popup.chart');
  const [pKey] = parseKeys('P');
  assert.equal(DEFAULT_KEYMAP.resolve(pKey, 'token'), 'screen.positions');
});

test('chartVMFromView: maps the live TokenView candles + stats into the ChartVM', () => {
  const v = emptyView({ mint: 'MINT1111', symbol: 'WIF', name: 'dogwifhat', launchpad: 'pump.fun' }, '1h');
  v.price = 0.0021; v.chg = { m5: 0.01, h1: 0.02, h6: null, h24: -0.03 }; v.liq = 1000; v.vol24 = 5000; v.mcap = 9000;
  v.candles = [{ t: 100, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }, { t: 200, o: 1.5, h: 2.5, l: 1, c: 2, v: 20 }];
  const vm = chartVMFromView(v);
  assert.equal(vm.symbol, 'WIF');
  assert.equal(vm.interval, '1h');
  assert.equal(vm.candles.length, 2);
  assert.equal(vm.openBarT, 200);          // the last bar is treated as the open bar
  assert.equal(vm.price, 0.0021);
  assert.equal(vm.chg.h24, -0.03);
});

test('tokenDetailVMFromView: carries identity/market/risk, no keys or commands', () => {
  const v = emptyView({ mint: 'MINT2222', symbol: 'VOID', name: 'void', launchpad: 'bonk' });
  v.holders = 1234; v.top10 = 42; v.rug = { score: 7, raw: null, risks: [{ name: 'mint authority', level: 'warn' }], lpLockedPct: null };
  const vm = tokenDetailVMFromView(v);
  assert.equal(vm.symbol, 'VOID');
  assert.equal(vm.holders, 1234);
  assert.equal(vm.rugScore, 7);
  assert.equal(vm.risks[0]?.name, 'mint authority');
  // the VM is a plain data object: it must not carry anything executable
  assert.ok(!('signer' in vm) && !('trade' in vm));
});

test('popupThemeFrom: maps a Theme to the popup token subset incl. the three rain ramps', () => {
  const t = popupThemeFrom(THEMES.cyberspace);
  assert.equal(t.bg, THEMES.cyberspace.bg);
  assert.equal(t.accent, THEMES.cyberspace.accent);
  assert.equal(t.rain.length, 4);
  assert.equal(t.rainPump.length, 4);
  assert.equal(t.rainDump.length, 4);
});

test('`trenchscope popup` without --self-test prints usage and exits 2 (no window launched)', async () => {
  const h = fakeIo();
  assert.equal(await main(['popup'], h.io), 2);
  assert.match(h.err(), /--self-test/);
});

// Regression (task-1290, Defect 1): after the wry window shell crashes, ShellPopupHost.close() throws
// "shell not running". Before the fix, pressing C to close the chart popup let that throw escape
// togglePopupChart as an unhandled rejection → the process fatal handler → the whole TUI died. closeChart
// must now swallow it, clear its own state, and surface a note. This drives a fake manager whose handle
// close() throws exactly like a dead shell, so no real window is spawned.
test('closeChart never crashes the TUI when the window shell has already died (task-1290)', async () => {
  let closeAttempts = 0;
  const deadShellManager = (): PopupManager => ({
    native: true, reason: 'wry shell', hotkeyRegistered: true, port: 65000,
    async open() {
      return {
        id: 'p_dead', kind: 'chart', native: true,
        setData() {}, show() {}, hide() {}, focus() {}, alwaysOnTop() {},
        close() { closeAttempts++; throw new Error('shell not running'); },
      };
    },
    setData() {}, close() {}, async shutdown() {},
  });
  const notes: string[] = [];
  const popups = new TokenPopups({ theme: THEMES.cyberspace, onNote: (m) => notes.push(m), createManager: deadShellManager });
  const view = emptyView({ mint: 'MDEAD', symbol: 'DED', name: 'dead', launchpad: 'pump.fun' }, '1h');
  await popups.openChart(view);
  assert.equal(popups.chartOpen(), true);

  assert.doesNotThrow(() => popups.closeChart(), 'a dead-shell close must not throw into the TUI');
  assert.equal(closeAttempts, 1, 'the underlying window close was still attempted');
  assert.equal(popups.chartOpen(), false, 'popup state is cleared even though close threw');
  assert.ok(notes.some((n) => /already gone|shell not running/i.test(n)), 'the failure surfaces as a note, not a crash');
  // Idempotent and still safe on a second close with nothing open.
  assert.doesNotThrow(() => popups.closeChart());
  assert.equal(closeAttempts, 1);
});
