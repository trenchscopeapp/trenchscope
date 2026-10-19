// task-1325: the chart page's pure helpers (src/pages/chart-lib.js), loaded exactly as the page gets them
// (one script, attaches window.DTChart) through node:vm.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { fmtPrice as tuiFmtPrice, fmtMcapBare as tuiFmtMcapBare } from '@dexterm/tui';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '..', 'src', 'pages', 'chart-lib.js'), 'utf8');

type Bar = { t: number; time: number; open: number; high: number; low: number; close: number; volume: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function load(): any { const win: Record<string, unknown> = {}; vm.runInNewContext(src, { window: win }); return win.DTChart; }
const C = load();
const H = 3_600_000, M = 60_000;
/** vm-realm arrays/objects → this realm (deepStrictEqual checks prototypes). */
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const candle = (t: number, o: number, h: number, l: number, c: number, v = 1) => ({ t, o, h, l, c, v });

test('toBars: sorts, de-duplicates, drops non-finite, keeps the real ms in t', () => {
  const bars: Bar[] = C.toBars([candle(2 * H, 2, 3, 1, 2.5), candle(H, 1, 2, 0.5, 1.5), candle(2 * H, 9, 9, 9, 9), { t: 3 * H, o: NaN, h: 1, l: 1, c: 1, v: 1 }]);
  assert.equal(bars.length, 2);
  assert.deepEqual(plain(bars.map((b) => b.time)), [3600, 7200]);
  assert.equal(bars[1].close, 9, 'a later duplicate replaces the earlier one');
  assert.equal(bars[0].t, H);
});

test('setTzOffset shifts chart time only (VWAP keeps anchoring on the real UTC day)', () => {
  const D = load();
  D.setTzOffset(-4 * 3600);
  const bars: Bar[] = D.toBars([candle(H, 1, 1, 1, 1)]);
  assert.equal(bars[0].time, 3600 - 4 * 3600);
  assert.equal(bars[0].t, H);
  assert.equal(D.barTimeOf(H + 5 * M, H), 3600 - 4 * 3600);
});

test('ema: SMA seed then the standard recursion', () => {
  const bars: Bar[] = C.toBars([1, 2, 3, 4, 5, 6].map((c, i) => candle(i * M, c, c, c, c)));
  const e = C.ema(bars, 3);
  assert.equal(e.length, 4);
  assert.equal(e[0].value, 2); // (1+2+3)/3
  assert.equal(e[1].value, 4 * 0.5 + 2 * 0.5);
  assert.deepEqual(plain(C.ema(bars.slice(0, 2), 3)), [], 'not enough bars → empty');
});

test('sma over volume points', () => {
  const pts = [1, 2, 3, 4].map((v, i) => ({ time: i, value: v }));
  assert.deepEqual(plain(C.sma(pts, 2).map((p: { value: number }) => p.value)), [1.5, 2.5, 3.5]);
});

test('vwap: volume-weighted typical price, resets at 00:00 UTC', () => {
  const day = 86_400_000;
  const bars: Bar[] = C.toBars([candle(day - 2 * H, 10, 12, 8, 10, 1), candle(day - H, 20, 22, 18, 20, 3), candle(day, 100, 100, 100, 100, 5)]);
  const v = C.vwap(bars);
  assert.equal(v[0].value, 10);
  assert.equal(v[1].value, (10 * 1 + 20 * 3) / 4);
  assert.equal(v[2].value, 100, 'new UTC day: anchored again');
});

test('tapeMarkers: one arrow per side per EXISTING bar, sized by USD, sorted', () => {
  const bars: Bar[] = C.toBars([candle(0, 1, 1, 1, 1), candle(M, 1, 1, 1, 1)]);
  const times = new Set(bars.map((b) => b.time));
  const trades = [
    { t: 5_000, side: 'buy', usd: 10, price: 1 }, { t: 6_000, side: 'buy', usd: 10_000, price: 1 }, { t: 70_000, side: 'sell', usd: 50, price: 1 },
    { t: 10 * M, side: 'buy', usd: 5, price: 1 }, // no bar at 10m → no marker
    { t: 7_000, side: 'transfer', usd: 1, price: 1 }, // junk side ignored
  ];
  const m = C.tapeMarkers(trades, M, times, { up: 'g', down: 'r' });
  assert.equal(m.length, 2);
  assert.deepEqual(plain(m.map((x: { shape: string; time: number }) => [x.time, x.shape])), [[0, 'arrowUp'], [60, 'arrowDown']]);
  assert.ok(m[0].size > m[1].size, 'more USD → bigger marker');
});

test('fillMarkers: exact fill price when known, bar position otherwise; outside the series skipped', () => {
  const bars: Bar[] = C.toBars([candle(0, 1, 1, 1, 1), candle(M, 1, 1, 1, 1)]);
  const times = new Set(bars.map((b) => b.time));
  const m = C.fillMarkers([
    { t: 1_000, side: 'buy', priceUsd: 0.5, sol: 0.5, tokens: 1 },
    { t: 61_000, side: 'sell', priceUsd: null, sol: 0.25, tokens: 1 },
    { t: 99 * M, side: 'buy', priceUsd: 1, sol: 1, tokens: 1 },
  ], M, times, { buy: 'c', sell: 'y' });
  assert.equal(m.length, 2);
  assert.equal(m[0].position, 'atPriceBottom'); assert.equal(m[0].price, 0.5); assert.match(m[0].text, /^BUY 0\.50 SOL$/);
  assert.equal(m[1].position, 'aboveBar'); assert.equal(m[1].shape, 'arrowDown');
});

test('fillMarkers: a fill newer than the last candle (feed lag) snaps to the last bar, up to 3 periods', () => {
  const bars: Bar[] = C.toBars([candle(0, 1, 1, 1, 1), candle(M, 1, 1, 1, 1)]);
  const times = new Set(bars.map((b) => b.time));
  const m = C.fillMarkers([
    { t: 2 * M + 5_000, side: 'buy', priceUsd: 1, sol: 0.05, tokens: 1 },   // 1 period past the last bar → last bar
    { t: 9 * M, side: 'sell', priceUsd: 1, sol: 0.05, tokens: 1 },          // 8 periods past → skipped
  ], M, times, { buy: 'c', sell: 'y' });
  assert.equal(m.length, 1);
  assert.equal(m[0].time, 60);
});

test('mergeTail: replaces the forming bar, appends a new one, ignores older-than-window', () => {
  const bars: Bar[] = C.toBars([0, 1, 2, 3, 4].map((i) => candle(i * M, 1, 1, 1, 1)));
  const a: Bar[] = C.mergeTail(bars, [candle(4 * M, 1, 2, 1, 2)]);
  assert.equal(a.length, 5); assert.equal(a[4].close, 2);
  const b2: Bar[] = C.mergeTail(a, [candle(4 * M, 1, 2, 1, 2), candle(5 * M, 2, 3, 2, 3)]);
  assert.equal(b2.length, 6); assert.equal(b2[5].close, 3);
  assert.equal(bars[4].close, 1, 'input not mutated');
});

test('logicalOf / timeOfLogical are inverses, extrapolating past both ends', () => {
  const bars: Bar[] = C.toBars([0, 1, 2, 3].map((i) => candle(i * M, 1, 1, 1, 1)));
  for (const t of [-120, 0, 30, 90, 180, 300]) assert.ok(Math.abs(C.timeOfLogical(bars, C.logicalOf(bars, t, 60), 60) - t) < 1e-9, String(t));
});

test('price formatting matches the terminal (subscript zero-compression) and scales precision', () => {
  for (const p of [0.0000123, 0.00031, 0.0042, 0.5, 3.2, 142.1, 12345]) assert.equal(C.fmtPrice(p), tuiFmtPrice(p), String(p));
  assert.equal(C.fmtAxis(0.0000123), tuiFmtPrice(0.0000123).replace('$', ''));
  assert.ok(C.priceFormatFor(0.00000031).minMove <= 1e-9);
  assert.ok(C.priceFormatFor(142).minMove >= 0.001);
});

// ------------------------------------------------------------------ task-1366: market-cap axis

test('task-1366 fmtMcapAxis mirrors the terminal formatter (K/M/B/T, tiny and huge values)', () => {
  for (const n of [0, 0.42, 0.0001234, 1, 12.34, 950, 999.9, 4500, 45_000, 300_000, 999_499, 999_999, 1_200_000, 1_234_567, 12_345_678, 123_456_789, 999_999_999, 1.2e9, 2.5e12, 3.2e15, -1.5e6]) {
    assert.equal(C.fmtMcapAxis(n), tuiFmtMcapBare(n), String(n));
  }
  assert.equal(C.fmtMcapAxis(300_000), '300K');
  assert.equal(C.fmtMcapAxis(1_200_000), '1.2M');
  assert.equal(C.fmtMcapAxis(Number.NaN), '—');
});

test('task-1366 displayOf: mcap only with a usable supply; mcap mode without one is price + a visible note', () => {
  assert.deepEqual({ ...C.displayOf(null) }, { mode: 'price', supply: null, label: null, key: 'price' }); // spread: the lib runs in a vm realm
  assert.deepEqual({ ...C.displayOf({ priceMode: 'price', supply: 1e9 }) }, { mode: 'price', supply: null, label: null, key: 'price' });
  const d = C.displayOf({ priceMode: 'mcap', supply: 1e9 });
  assert.equal(d.mode, 'mcap'); assert.equal(d.supply, 1e9); assert.equal(d.label, 'mcap (current supply)');
  for (const supply of [null, 0, -5, Number.NaN, undefined]) {
    const f = C.displayOf({ priceMode: 'mcap', supply });
    assert.equal(f.mode, 'price', String(supply)); assert.equal(f.label, 'supply unknown · showing price');
  }
  // a tick that moves the supply below the 4th significant digit keeps the key (no re-format per tick)
  assert.equal(C.displayOf({ priceMode: 'mcap', supply: 1_000_000_000 }).key, C.displayOf({ priceMode: 'mcap', supply: 1_000_040_000 }).key);
});

test('task-1366 popup Y-axis formatter: price × supply in K/M/B; price mode keeps the price label', () => {
  const mc = C.axisFormatter(C.displayOf({ priceMode: 'mcap', supply: 1e9 }));
  assert.equal(mc(0.0003), '300K');
  assert.equal(mc(0.0012), '1.2M');
  assert.equal(mc(1.5), '1.5B');
  const px = C.axisFormatter(C.displayOf({ priceMode: 'price' }));
  assert.equal(px(0.0000123), C.fmtAxis(0.0000123));
  assert.equal(C.axisFormatter(C.displayOf({ priceMode: 'mcap', supply: null }))(0.0012), C.fmtAxis(0.0012));
});

test('task-1366 crosshair legend: mcap with the price in parentheses on the close; price mode unchanged', () => {
  const bar = C.toBars([candle(0, 0.001, 0.0012, 0.0009, 0.0011)])[0];
  const lg = C.legendFor(bar, null, C.displayOf({ priceMode: 'mcap', supply: 1e9 }));
  assert.equal(lg.o, '1M'); assert.equal(lg.h, '1.2M'); assert.equal(lg.l, '900K');
  assert.equal(lg.c, `1.1M (${C.fmtPrice(0.0011)})`);
  const pl = C.legendFor(bar, null);
  assert.equal(pl.c, C.fmtAxis(0.0011));
  assert.deepEqual({ ...C.legendFor(bar, null, C.displayOf({ priceMode: 'mcap', supply: null })) }, { ...pl });
});
