import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPopupManager, assertLoopbackUrl } from '../src/open.ts';
import type { ChartVM } from '../src/protocol.ts';

const vm: ChartVM = { symbol: 'WIF', name: 'dogwifhat', mint: 'MINT', interval: '1h', price: 1, chg: { m5: 0, h1: 0, h6: 0, h24: 0 }, liq: 1, vol24: 1, mcap: 1, candles: [], openBarT: null, updatedAt: 1 };

// platform 'linux' + forceBrowser → the browser fallback host; its open() spawns `xdg-open` (absent on the
// test box, harmless), so no real browser window is launched and nothing blocks.

test('createPopupManager: opens via the browser fallback, reports native=false, serves a loopback port', async () => {
  const warns: string[] = [];
  const mgr = createPopupManager({ forceBrowser: true, platform: 'linux', onWarn: (m) => warns.push(m) });
  try {
    const h = await mgr.open({ kind: 'chart', title: 'WIF', data: vm });
    assert.equal(mgr.native, false);
    assert.equal(h.native, false);
    assert.equal(mgr.hotkeyRegistered, false);
    assert.ok(typeof mgr.port === 'number' && (mgr.port ?? 0) > 0, 'a loopback server port is allocated even under the fallback');
    assert.match(mgr.reason, /browser/i);
    assert.ok(warns.some((w) => /browser/i.test(w)), 'the fallback is announced via onWarn');
    // setData / close must not throw
    h.setData(vm); h.show(); h.hide(); h.focus(); h.alwaysOnTop(true); h.close();
  } finally {
    await mgr.shutdown();
  }
});

// Defect 2 (task-1290): a custom `url` is pinned to our own loopback server origin. A same-origin url
// opens without a server ticket; https / another host / another port / a non-http scheme are all refused
// before any window or browser tab is opened (ROADMAP "no remote content").
test('createPopupManager: a same-origin loopback url opens; remote/off-origin urls are refused', async () => {
  const mgr = createPopupManager({ forceBrowser: true, platform: 'linux' });
  try {
    // Start the server (and learn our own port) by opening a normal ticketed popup first.
    await mgr.open({ kind: 'chart', data: vm });
    const port = mgr.port!;
    assert.ok(port > 0);

    const h = await mgr.open({ kind: 'chart', url: `http://127.0.0.1:${port}/popup/chart?p=external` });
    assert.ok(h.id.startsWith('p_'));
    assert.equal(h.native, false);

    await assert.rejects(() => mgr.open({ kind: 'chart', url: 'https://evil.example/claim' }), /http:\/\/ loopback|must be an http/);
    await assert.rejects(() => mgr.open({ kind: 'chart', url: 'http://evil.example/' }), /host must be 127\.0\.0\.1/);
    await assert.rejects(() => mgr.open({ kind: 'chart', url: 'http://127.0.0.1:1/popup/chart?p=x' }), /port must be/);
    await assert.rejects(() => mgr.open({ kind: 'chart', url: 'file:///etc/passwd' }), /must be an http/);
  } finally {
    await mgr.shutdown();
  }
});

test('assertLoopbackUrl: accepts our own origin, rejects remote / other-port / non-http / junk', () => {
  assert.equal(assertLoopbackUrl('http://127.0.0.1:5000/popup/chart?p=a', 5000), 'http://127.0.0.1:5000/popup/chart?p=a');
  assert.throws(() => assertLoopbackUrl('https://127.0.0.1:5000/', 5000), /must be an http/);
  assert.throws(() => assertLoopbackUrl('http://127.0.0.1:5001/', 5000), /port must be/);
  assert.throws(() => assertLoopbackUrl('http://evil.example/', 5000), /host must be/);
  assert.throws(() => assertLoopbackUrl('http://localhost:5000/', 5000), /host must be/);
  assert.throws(() => assertLoopbackUrl('file:///etc/passwd', 5000), /must be an http/);
  assert.throws(() => assertLoopbackUrl('not a url', 5000), /not a valid URL/);
});
