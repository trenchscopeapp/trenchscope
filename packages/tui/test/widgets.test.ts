import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Canvas, THEMES, table, sparkline, sparkArea, heatPct, bar, ratioBar, badge, launchpadBadge, statGrid, keyHints,
  candleChart, breakpoint, header, footer, resample, BLOCKS, neon, fmtPctDir, mix, tapeRain, type Column,
} from '../src/index.ts';
import type { Candle } from '@dexterm/data';

const T = THEMES.midnight;

interface Row { a: string; b: number }
const rows: Row[] = [{ a: 'one', b: 1 }, { a: 'two', b: 2 }, { a: 'three', b: 3 }];
const cols = (): Column<Row>[] => [
  { key: 'a', label: 'A', w: 5, prio: 0, flex: true, render: (c, x, y, w, r, bg) => { c.text(x, y, r.a, { bg }, w); } },
  { key: 'b', label: 'B', w: 3, align: 'right', prio: 1, render: (c, x, y, w, r, bg) => { c.textR(x, y, w, String(r.b), { bg }); } },
  { key: 'c', label: 'C', w: 4, prio: 2, render: (c, x, y, _w, _r, bg) => { c.text(x, y, 'cc', { bg }); } },
];

test('table drops columns by priority and gives leftover width to the flex column', () => {
  const wide = new Canvas(20, 5, T);
  const r1 = table(wide, 0, 0, 20, 5, { columns: cols(), rows });
  assert.deepEqual(r1.cols, ['a', 'b', 'c']);
  assert.equal(r1.rowsVisible, 3);
  assert.equal(wide.toPlain().split('\n')[0], 'A             B C', 'flex column absorbs the 6 leftover columns');
  const narrow = new Canvas(9, 5, T);
  const r2 = table(narrow, 0, 0, 9, 5, { columns: cols(), rows });
  assert.deepEqual(r2.cols, ['a', 'b'], 'prio 2 dropped first');
  const tiny = new Canvas(4, 5, T);
  const r3 = table(tiny, 0, 0, 4, 5, { columns: cols(), rows });
  assert.deepEqual(r3.cols, ['a'], 'prio 0 always kept');
});

test('table marks the sort column and the selected row', () => {
  const c = new Canvas(20, 5, T);
  table(c, 1, 0, 18, 5, { columns: cols(), rows, selected: 0, sortKey: 'b', sortDir: 'desc' });
  const lines = c.toPlain().split('\n');
  assert.match(lines[0], /▼ B/);
  assert.equal(lines[2][0], '▎', 'selection marker left of the selected row');
  assert.equal(c.bg[c.idx(1, 2)], T.selBg);
  assert.equal(c.bg[c.idx(1, 3)], T.panelAlt, 'second body row is zebra-striped');
  assert.equal(c.bg[c.idx(1, 4)], T.panel, 'third body row is not');
});

test('table honours scroll and stops at the last row', () => {
  const c = new Canvas(20, 4, T);
  table(c, 0, 0, 20, 4, { columns: cols(), rows, scroll: 2 });
  const lines = c.toPlain().split('\n');
  assert.match(lines[2], /^three/);
  assert.equal(lines[3], '');
});

test('sparkline uses the eight block levels and the neon gradient', () => {
  const c = new Canvas(8, 1, T);
  sparkline(c, 0, 0, 8, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(c.toPlain(), BLOCKS);
  assert.notEqual(c.fg[0], c.fg[7], 'left end is dim, the recent end is hot');
  assert.equal(c.fg[7], neon(T.sparkUp, 1, T.panel));
  assert.equal(c.hard[0], 0, 'viz glyphs are soft');
  const d = new Canvas(4, 1, T);
  sparkline(d, 0, 0, 4, [1, 1, 1, 1]);
  assert.equal(d.toPlain(), '▁▁▁▁', 'flat series renders the lowest block');
  const e = new Canvas(4, 1, T);
  sparkline(e, 0, 0, 4, [1]);
  assert.equal(e.toPlain(), '', 'too few points draws nothing');
});

test('resample interpolates to the target width', () => {
  assert.deepEqual(resample([0, 10], 3), [0, 5, 10]);
  assert.deepEqual(resample([1, 2, 3], 3), [1, 2, 3]);
});

test('sparkArea stacks rows from the bottom with a braille halo above the edge', () => {
  const c = new Canvas(3, 2, T);
  sparkArea(c, 0, 0, 3, 2, [0, 0.5, 1]);
  const lines = c.toPlain().split('\n');
  assert.equal(lines[1], '▁██');
  assert.equal(lines[0], '⣀▁█', 'halo over the low column');
});

test('heatPct tints, bolds above 24 % and renders — for null', () => {
  const c = new Canvas(8, 3, T);
  heatPct(c, 0, 0, 8, 5, T.panel);
  heatPct(c, 0, 1, 8, -30, T.panel);
  heatPct(c, 0, 2, 8, null, T.panel);
  const lines = c.toPlain().split('\n');
  assert.equal(lines[0], '   ▲5.0%');
  assert.equal(lines[1], '  ▼30.0%');
  assert.equal(lines[2], '       —');
  assert.equal(c.at[c.idx(7, 0)] & 1, 0);
  assert.equal(c.at[c.idx(7, 1)] & 1, 1, 'bold above 24 %');
  assert.equal(c.fg[c.idx(7, 0)], T.up);
  assert.equal(c.fg[c.idx(7, 1)], mix(T.down, '#ffffff', 0.3), 'hot cells lift toward white');
  assert.equal(fmtPctDir(0), '◆0.0%');
  assert.equal(fmtPctDir(null), '—');
  assert.notEqual(c.bg[c.idx(0, 1)], T.panel, 'background tinted');
});

test('bar and ratioBar fill proportionally', () => {
  const c = new Canvas(10, 2, T);
  bar(c, 0, 0, 10, 50);
  ratioBar(c, 0, 1, 10, 3, 1);
  const lines = c.toPlain().split('\n');
  assert.equal(lines[0], '█████▓░░░░', 'gradient fill, one glow cell past the head');
  assert.equal(lines[1], '━━━━━━━━━━');
  assert.equal(c.fg[c.idx(7, 1)], T.up, 'the buy side brightens to full colour at the meeting point');
  assert.equal(c.fg[c.idx(8, 1)], T.down, 'the sell side is brightest at the meeting point');
  assert.notEqual(c.fg[c.idx(9, 1)], T.down, 'and fades toward its end');
  const d = new Canvas(4, 1, T);
  bar(d, 0, 0, 4, 250);
  assert.equal(d.toPlain(), '████', 'pct clamps to 100');
});

test('badge pads with spaces, tints 18 %, returns the next x; launchpad labels map', () => {
  const c = new Canvas(20, 1, T);
  const nx = badge(c, 0, 0, 'MINT', T.down, { on: T.panel });
  assert.equal(nx, 6);
  assert.equal(c.toPlain(), ' MINT');
  assert.equal(c.fg[0], T.down);
  assert.notEqual(c.bg[0], T.panel);
  const d = new Canvas(40, 1, T);
  let x = 0;
  for (const lp of ['pump.fun', 'dbc', 'raydium', 'meteora', 'bonk', 'unknown'] as const) x = launchpadBadge(d, x, 0, lp);
  assert.equal(d.toPlain(), ' PUMP  DBC  RAY  MET  BONK  UNKN');
  assert.equal(d.fg[1], T.pump);
  assert.equal(d.fg[d.idx(28, 0)], T.muted);
});

test('statGrid lays items in a grid and reports its height', () => {
  const c = new Canvas(30, 4, T);
  const h = statGrid(c, 0, 0, 30, [
    { label: 'mcap', value: '$1.0M' }, { label: 'liq', value: '$10K', sub: '1%' }, { label: 'x', value: 'y' },
  ], { cols: 2 });
  assert.equal(h, 4);
  const lines = c.toPlain().split('\n');
  assert.equal(lines[0], 'MCAP           LIQ');
  assert.equal(lines[1], '$1.0M          $10K 1%');
  assert.equal(lines[2], 'X');
});

test('keyHints stops when the next hint would overflow', () => {
  const c = new Canvas(20, 1, T);
  keyHints(c, 0, 0, 20, [['j', 'down'], ['⏎', 'open'], ['q', 'quit']], T.headBg);
  assert.equal(c.toPlain(), ' j  down   ⏎  open');
});

test('candleChart draws bodies, axis, volume and time labels', () => {
  const base = Date.UTC(2026, 9, 5, 0, 0, 0);
  const candles: Candle[] = Array.from({ length: 12 }, (_, i) => {
    const o = 1 + i * 0.01, c = o + (i % 2 ? 0.02 : -0.015);
    return { t: base + i * 3600e3, o, c, h: Math.max(o, c) + 0.005, l: Math.min(o, c) - 0.005, v: 100 + i * 10 };
  });
  const c = new Canvas(60, 16, T);
  candleChart(c, 0, 0, 60, 16, candles, { interval: '1h' });
  const plain = c.toPlain();
  assert.match(plain, /[█▀▄━]/);
  assert.match(plain, /1h UTC$/);
  assert.match(plain, /05\/10 00:00/);
  assert.match(plain, /vol/);
  assert.match(plain, /·/, 'gridlines');
  const tiny = new Canvas(12, 5, T);
  candleChart(tiny, 0, 0, 12, 5, candles);
  assert.equal(tiny.toPlain().trim(), '', 'too small draws nothing');
});

test('breakpoints follow SPEC §7.4', () => {
  assert.equal(breakpoint(80), 'compact');
  assert.equal(breakpoint(99), 'compact');
  assert.equal(breakpoint(100), 'standard');
  assert.equal(breakpoint(139), 'standard');
  assert.equal(breakpoint(140), 'wide');
  assert.equal(breakpoint(176), 'wide');
});

test('header shows tabs, SOL, live marker and a zone-pinned clock; footer shows theme and size', () => {
  const c = new Canvas(120, 3, T);
  header(c, { screen: 'newpairs', paused: false, sol: { price: 120.73, chg24: -0.67 }, now: new Date(Date.UTC(2026, 9, 5, 23, 4, 11)), timeZone: 'America/New_York' });
  const line = c.toPlain().split('\n')[0];
  assert.match(line, /trenchscope ┃  1 Screener   2 New pairs ▌ 3 Watchlist   4 Analyst/);
  assert.match(line, /SOL \$120\.73 ▼0\.7%  ◉ live  19:04:11$/);
  assert.ok(c.zone[c.idx(0, 1)] === 1 && c.zone[c.idx(70, 0)] === 1, 'header gap and the band under it are rain zones');
  assert.ok(c.headings.some((h) => h.y === 0 && h.x === 2), 'the logo is a heading');
  const p = new Canvas(120, 3, T);
  header(p, { screen: 'screener', paused: true, sol: { price: 1, chg24: 0 }, now: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)), timeZone: 'UTC' });
  assert.match(p.toPlain().split('\n')[0], /◌ paused  12:00:00$/);
  const d = new Canvas(120, 3, T);
  header(d, { screen: 'screener', paused: false, sol: { price: 1, chg24: 0 }, now: new Date(0), timeZone: 'UTC', status: '◐ degraded: gecko' });
  assert.match(d.toPlain().split('\n')[0], /◐ degraded: gecko/);
  // live mode without a SOL quote: the cluster is omitted rather than showing a stale/fixture number (D-03)
  const n = new Canvas(120, 3, T);
  header(n, { screen: 'screener', paused: false, sol: null, now: new Date(0), timeZone: 'UTC', feedLabel: 'dexscreener · jup' });
  const nl = n.toPlain().split('\n')[0];
  assert.doesNotMatch(nl, /SOL \$/);
  assert.match(nl, /4 Analyst\s+◉ live  00:00:00$/);
  const f = new Canvas(60, 2, T);
  footer(f, [['q', 'quit']], 'ember');
  // Prototype parity: the theme/size label is drawn at the last column and clipped, so it
  // never shows (also absent from the reference screenshots). Fix is queued for D-19.
  assert.equal(f.toPlain().split('\n')[1], '  q  quit');
  assert.equal(f.bg[f.idx(59, 1)], T.headBg);
  assert.equal(f.zone[f.idx(20, 1)], 1, 'free footer space rains');
  assert.equal(f.hard[f.idx(1, 1)], 1, 'key caps are hard cells');
  const k = new Canvas(120, 3, T);
  header(k, { screen: 'screener', paused: false, sol: null, now: new Date(0), timeZone: 'UTC', calm: true });
  assert.match(k.toPlain().split('\n')[0], /◉ live · calm  00:00:00$/);
});

test('tapeRain: one column per trade, ▲/▼ heads, buys green and sells red, soft cells, nothing outside its rect', () => {
  const c = new Canvas(12, 6, T);
  const trades = [{ side: 'buy' as const, usd: 5000 }, { side: 'sell' as const, usd: 50 }, { side: 'buy' as const, usd: 900 }];
  tapeRain(c, 2, 1, 6, 4, trades, 7);
  const plain = c.toPlain();
  assert.match(plain, /[▲▼│]/);
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
    const i = c.idx(x, y);
    if (c.ch[i] === ' ') continue;
    assert.ok(x >= 2 && x < 8 && y >= 1 && y < 5, `cell at ${x},${y} outside the tape rect`);
    assert.equal(c.hard[i], 0);
    assert.ok(x !== 3 || c.fg[i] !== T.up, 'sell column never green');
  }
});
