// task-1325: chart popup v2 — the TUI side. View model (interval from the cache, tape, position, no keys),
// the shared task-1323 position selector, popup → TUI requests answered from TokenLive's cache (no fetch),
// the full/tail push protocol and its throttle. No window and no network: a fake PopupManager records pushes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { THEMES } from '@dexterm/tui';
import { aggregateCandles, type Candle, type CandleInterval, type DataLayer } from '@dexterm/data';
import type { PopupManager, PopupManagerOptions, ChartVM, ServerEvent } from '@dexterm/popup';
import { chartVMFromView, chartPositionFrom, currentPositionFills, positionCells, TokenPopups, type ChartSource, type LedgerFill, type CachedSeries } from '../src/popup.ts';
import { emptyView, TokenLive, type TokenView } from '../src/live/token.ts';
import { positionRow, type HeldPosition } from '../src/live/trade.ts';

const M = 60_000, H = 3_600_000;
function bars1m(n: number, t0 = 0, p = 1): Candle[] { return Array.from({ length: n }, (_, i) => ({ t: t0 + i * M, o: p, h: p * 1.01, l: p * 0.99, c: p * (1 + i * 1e-4), v: 10 + i })); }
function view(mint = 'MINT1', iv: CandleInterval = '1h'): TokenView {
  const v = emptyView({ mint, symbol: 'WIF', name: 'dogwifhat', launchpad: 'pump.fun' }, iv);
  v.price = 1.5; v.chg = { m5: 0, h1: 0.01, h6: 0, h24: 0.2 };
  v.candles = aggregateCandles(bars1m(600), M, H);
  v.panels.candles = { state: 'ok', via: 'geckoterminal', reason: null, fetchedAt: 1, stale: false };
  v.trades = [{ t: 5 * M, side: 'buy', usd: 100, price: 1, wallet: 'WaLLetAddr1111111111111111111111111111' }];
  return v;
}
const HELD: HeldPosition = { mint: 'MINT1', symbol: 'WIF', side: 'long', tokens: 1_234_567, costSol: 2, avgEntrySol: 2 / 1_234_567, realizedSol: 0.1, markSol: null, stopUsd: null, targetUsd: null };

/** Every key anywhere in a JSON value. */
function allKeys(x: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(x)) for (const e of x) allKeys(e, out);
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { out.add(k); allKeys(v, out); }
  return out;
}

test('chartVMFromView without extras is the task-1290 VM (unchanged shape)', () => {
  const vm = chartVMFromView(view());
  assert.equal(vm.interval, '1h');
  assert.equal(vm.mode, undefined);
  assert.equal(vm.trades, undefined);
});

test('chart VM: popup interval served from the cached series; cold → empty + cold flag; tape has no wallets; no keys anywhere', () => {
  const v = view();
  const series: CachedSeries = { candles: aggregateCandles(bars1m(600), M, 5 * M), fetchedAt: 1, stale: false, derived: true };
  const vm = chartVMFromView(v, { interval: '5m', series, feed: 'POLL', now: 42 });
  assert.equal(vm.interval, '5m');
  assert.equal(vm.candles.length, 120);
  assert.equal(vm.cold, false);
  assert.equal(vm.seriesKey, 'MINT1|5m|0');
  assert.equal(vm.sentAt, 42);
  assert.deepEqual(vm.trades, [{ t: 5 * M, side: 'buy', usd: 100, price: 1 }]);
  const cold = chartVMFromView(v, { interval: '4h', series: null });
  assert.equal(cold.cold, true);
  assert.equal(cold.candles.length, 0);
  const held = chartVMFromView(v, { interval: '5m', series, held: HELD, solUsd: 150, fills: [] });
  const keys = allKeys(held);
  for (const bad of ['wallet', 'signer', 'secret', 'key', 'privateKey', 'mandate', 'trade', 'ticket', 'rpc', 'apiKey']) assert.ok(!keys.has(bad), `no "${bad}" field in the chart VM`);
  assert.ok(!JSON.stringify(held).includes('WaLLetAddr'), 'tape wallet addresses never reach the popup');
});

test('position: same selector (positionRow) and the terminal row order SIDE · SIZE · VALUE · AVG ENTRY · PRICE · UNREALIZED', () => {
  const pos = chartPositionFrom(HELD, 0.0003, 150, 'paper');
  assert.deepEqual(pos.cells.map((c) => c.label), ['SIDE', 'SIZE', 'VALUE', 'AVG ENTRY', 'PRICE', 'UNREALIZED', 'REALIZED']);
  assert.equal(pos.cells[0].value, 'LONG');
  assert.equal(pos.cells[1].value, '1.23M WIF');
  assert.equal(pos.sizeLabel, '1.23M WIF');
  const row = positionRow(HELD, 0.0003, 150);
  assert.equal(pos.avgEntryUsd, row.avgEntryUsd);
  assert.equal(pos.unrealizedPct, row.unrealizedPct);
  assert.equal(pos.caption, 'paper ledger · SOL $150.00');
  assert.equal(pos.stopUsd, null); assert.equal(pos.targetUsd, null);
  assert.deepEqual(positionCells(row), pos.cells);
  // unknown SOL/USD: entry is in SOL units → no USD entry line, the row says so
  const noSol = chartPositionFrom({ ...HELD, markSol: 2.2 / 1_234_567 }, null, null, 'paper');
  assert.equal(noSol.avgEntryUsd, null);
  assert.match(noSol.caption, /SOL units/);
  assert.match(noSol.cells[3].value, / SOL$/);
});

test('position: synthetic stop/target (the paper ledger never sets them) → levels + STOP/TARGET cells with distance', () => {
  const pos = chartPositionFrom({ ...HELD, stopUsd: 0.00025, targetUsd: 0.0004 }, 0.0003, 150, 'paper');
  assert.equal(pos.stopUsd, 0.00025);
  assert.equal(pos.targetUsd, 0.0004);
  const labels = pos.cells.map((c) => c.label);
  assert.deepEqual(labels.slice(-2), ['STOP', 'TARGET']);
  assert.match(pos.cells.find((c) => c.label === 'STOP')!.value, /-16\.7%$/);
  assert.match(pos.cells.find((c) => c.label === 'TARGET')!.value, /\+33\.3%$/);
});

test('not held → position null (nothing extra drawn)', () => {
  const vm = chartVMFromView(view(), { interval: '1h', held: null, fills: [{ t: 1, side: 'buy', priceUsd: 1, sol: 1, tokens: 1 }] });
  assert.equal(vm.position, null);
});

test('currentPositionFills: only the fills since the position was last flat, oldest first', () => {
  const f = (t: number, side: 'buy' | 'sell', tok: bigint): LedgerFill => ({ t, side, grossLamports: 500_000_000n, tokenDelta: side === 'buy' ? tok : -tok, decimals: 6, priceUsd: 0.001 });
  const rows = [f(5, 'sell', 50n), f(1, 'buy', 100n), f(2, 'sell', 100n), f(3, 'buy', 70n), f(4, 'buy', 30n)]; // any order in
  const cur = currentPositionFills(rows);
  assert.deepEqual(cur.map((x) => [x.t, x.side]), [[3, 'buy'], [4, 'buy'], [5, 'sell']]);
  assert.equal(cur[0].sol, 0.5);
  assert.equal(cur[0].tokens, 70 / 1e6);
});

// ------------------------------------------------------------------------------------------------ TokenPopups
function harness(opts: { series?: (iv: CandleInterval) => CachedSeries | null; held?: HeldPosition | null; now?: () => number; syncMinMs?: number } = {}) {
  const pushes: ChartVM[] = [];
  let onEvent: ((e: ServerEvent) => void) | undefined;
  let closed = 0;
  const seriesCalls: CandleInterval[] = [];
  const mgr = (o: PopupManagerOptions): PopupManager => {
    onEvent = o.onEvent;
    return {
      native: true, reason: 'test', hotkeyRegistered: false, port: 1,
      async open(req) { pushes.push(req.data as ChartVM); return { id: 'p1', kind: 'chart', native: true, setData: (d) => pushes.push(d as ChartVM), close() { closed++; }, show() {}, hide() {}, focus() {}, alwaysOnTop() {} }; },
      setData() {}, close() {}, async shutdown() {},
    };
  };
  const source: ChartSource = {
    series: (_m, iv) => { seriesCalls.push(iv); return (opts.series ?? ((i: CandleInterval) => ({ candles: aggregateCandles(bars1m(600), M, i === '1m' ? 0 : ({ '5m': 5, '15m': 15, '1h': 60 } as Record<string, number>)[i] * M) || bars1m(600), fetchedAt: 1, stale: false, derived: i !== '1m' })))(iv); },
    livePrice: () => null, feed: () => 'POLL',
    positions: { kind: 'paper', held: () => opts.held ?? null, solUsd: () => 150 },
    fills: () => [], solUsd: () => 150,
  };
  const tp = new TokenPopups({ theme: THEMES.cyberspace, env: { DEXTERM_HOME: '/nonexistent-1325' }, source, createManager: mgr, syncMinMs: opts.syncMinMs ?? 0, now: opts.now });
  const ev = (e: ServerEvent) => onEvent?.(e);
  return { tp, pushes, ev, seriesCalls, closed: () => closed };
}

test('TokenPopups: never sends a tail before the page is ready; after ready a tick is a 2-bar tail of the same series', async () => {
  const h = harness();
  const v = view();
  await h.tp.openChart(v);
  assert.equal(h.pushes[0].mode, 'full');
  h.tp.syncChart(v);
  assert.equal(h.pushes[1].mode, 'full', 'before ready: full (the server re-sends the stored VM on ready)');
  h.ev({ ev: 'popup.ready', popupId: 'p1', kind: 'chart', openToReadyMs: 1, page: 'chart' });
  h.tp.syncChart(v);
  assert.equal(h.pushes[2].mode, 'full', 'first push after ready is full');
  h.tp.syncChart(v);
  assert.equal(h.pushes[3].mode, 'tail');
  assert.equal(h.pushes[3].candles.length, 2);
  assert.equal(h.pushes[3].seriesKey, h.pushes[2].seriesKey);
  assert.deepEqual(h.tp.metrics.pushes, { full: 2, tail: 1 });
});

test('TokenPopups: a chart.interval request is answered at once from the cache (series() only), terminal timeframe untouched', async () => {
  const h = harness();
  const v = view('MINT1', '1h');
  await h.tp.openChart(v);
  h.ev({ ev: 'popup.ready', popupId: 'p1', kind: 'chart', openToReadyMs: 1, page: 'chart' });
  const before = h.pushes.length;
  h.ev({ ev: 'popup.event', popupId: 'p1', name: 'chart.interval', payload: { interval: '5m' } });
  assert.equal(h.pushes.length, before + 1, 'answered synchronously');
  const vm = h.pushes.at(-1)!;
  assert.equal(vm.interval, '5m');
  assert.equal(vm.mode, 'full');
  assert.equal(h.seriesCalls.at(-1), '5m');
  assert.equal(v.interval, '1h', 'the terminal view keeps its own timeframe');
  assert.equal(h.tp.chartInterval(v), '5m');
  // junk that slipped past (defence in depth): ignored
  h.ev({ ev: 'popup.event', popupId: 'p1', name: 'chart.interval', payload: { interval: '1s' } });
  assert.equal(h.pushes.length, before + 1);
  // events for another popup id are ignored
  h.ev({ ev: 'popup.event', popupId: 'other', name: 'chart.interval', payload: { interval: '1m' } });
  assert.equal(h.pushes.length, before + 1);
});

test('TokenPopups: indicator/style/scale requests are remembered and carried in the next VM; close-request closes', async () => {
  const h = harness();
  const v = view();
  await h.tp.openChart(v);
  h.ev({ ev: 'popup.ready', popupId: 'p1', kind: 'chart', openToReadyMs: 1, page: 'chart' });
  h.ev({ ev: 'popup.event', popupId: 'p1', name: 'chart.indicator', payload: { id: 'vwap', on: true } });
  h.ev({ ev: 'popup.event', popupId: 'p1', name: 'chart.indicator', payload: { id: 'tape', on: false } });
  h.ev({ ev: 'popup.event', popupId: 'p1', name: 'chart.style', payload: { style: 'area' } });
  h.ev({ ev: 'popup.event', popupId: 'p1', name: 'chart.scale', payload: { scale: 'log' } });
  h.tp.syncChart(v);
  const prefs = h.pushes.at(-1)!.prefs!;
  assert.equal(prefs.style, 'area'); assert.equal(prefs.scale, 'log');
  assert.ok(prefs.indicators.includes('vwap')); assert.ok(!prefs.indicators.includes('tape'));
  h.ev({ ev: 'popup.event', popupId: 'p1', name: 'popup.close-request', payload: {} });
  assert.equal(h.closed(), 1);
  assert.equal(h.tp.chartOpen(), false);
});

test('TokenPopups: held coin → position + fills; another (flat) coin → full push, no position', async () => {
  const h = harness({ held: HELD });
  await h.tp.openChart(view('MINT1'));
  h.ev({ ev: 'popup.ready', popupId: 'p1', kind: 'chart', openToReadyMs: 1, page: 'chart' });
  h.tp.syncChart(view('MINT1'));
  assert.ok(h.pushes.at(-1)!.position);
  const h2 = harness({ held: null });
  await h2.tp.openChart(view('MINT2'));
  assert.equal(h2.pushes.at(-1)!.position, null);
});

test('TokenPopups: pushes are coalesced to syncMinMs (trailing edge, newest view wins)', async () => {
  let now = 1000;
  const h = harness({ now: () => now, syncMinMs: 50 });
  const v = view();
  await h.tp.openChart(v);
  h.ev({ ev: 'popup.ready', popupId: 'p1', kind: 'chart', openToReadyMs: 1, page: 'chart' });
  h.tp.syncChart(v); // push (t=1000)
  const n = h.pushes.length;
  now = 1010; h.tp.syncChart(v); h.tp.syncChart(v); h.tp.syncChart(v);
  assert.equal(h.pushes.length, n, 'within 50 ms: coalesced');
  now = 1060;
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(h.pushes.length, n + 1, 'one trailing push');
  h.tp.shutdown();
});

test('TokenLive.cachedSeries: derives 5m/15m from 1m and 4h/1d from 1h locally — never touches the data layer', () => {
  const dl = new Proxy({}, { get(_t, k) { throw new Error(`data layer touched: ${String(k)}`); } }) as unknown as DataLayer;
  const tl = new TokenLive(dl, { mint: 'M', symbol: 'S', name: 'n', launchpad: 'pump.fun' }, { prefetchCandles: false });
  assert.equal(tl.cachedSeries('5m'), null, 'cold');
  (tl as unknown as { setBase: (b: CandleInterval, c: Candle[], f: number, s: boolean) => void }).setBase('1m', bars1m(600), 1, false);
  const s5 = tl.cachedSeries('5m')!;
  assert.equal(s5.derived, true);
  assert.equal(s5.candles.length, 120);
  assert.equal(tl.cachedSeries('15m')!.candles.length, 40);
  assert.equal(tl.cachedSeries('1m')!.derived, false);
  assert.equal(tl.cachedSeries('4h'), null, '1h base not cached → null, no fetch');
  assert.equal(tl.cachedSeries('1d'), null);
});

// ------------------------------------------------------------------------------------------------ docking (phase 2)
import type { DockPlacement } from '@dexterm/popup';
import { describeDock, type DockLike } from '../src/popup.ts';

function dockHarness(placement: DockPlacement | null, native = true) {
  const opens: Array<Record<string, unknown> | undefined> = [];
  const bounds: Array<{ x: number; y: number; w: number; h: number }> = [];
  let onEvent: ((e: ServerEvent) => void) | undefined;
  let follower: ((p: DockPlacement) => void) | null = null;
  const calls = { place: 0, follow: 0, stop: 0 };
  const dock: DockLike = {
    kind: placement?.kind ?? 'unknown',
    async place() { calls.place++; return placement; },
    follow(fn) { calls.follow++; follower = fn; },
    stop() { calls.stop++; follower = null; },
  };
  const mgr = (o: PopupManagerOptions): PopupManager => {
    onEvent = o.onEvent;
    return {
      native, reason: native ? 'wry shell' : 'browser requested', hotkeyRegistered: true, port: 1,
      async open(req) { opens.push(req.geom as Record<string, unknown> | undefined); return { id: 'p1', kind: 'chart', native, setData() {}, close() {}, show() {}, hide() {}, focus() {}, alwaysOnTop() {}, setBounds: (r) => bounds.push(r) }; },
      setData() {}, close() {}, async shutdown() {},
    };
  };
  const tp = new TokenPopups({ theme: THEMES.cyberspace, env: { DEXTERM_HOME: '/nonexistent-1325' }, createManager: mgr, dock });
  return { tp, opens, bounds, calls, ev: (e: ServerEvent) => onEvent?.(e), move: (p: DockPlacement) => follower?.(p) };
}
const RIGHT: DockPlacement = { rect: { x: 1104, y: 60, w: 560, h: 800 }, mode: 'right', ontop: false, kind: 'terminal' };

test('docking: the probe decides the window rect (unfocused, not on top when beside the terminal) and the toast says where', async () => {
  const h = dockHarness(RIGHT);
  const r = await h.tp.openChart(view());
  assert.deepEqual(h.opens[0], { x: 1104, y: 60, w: 560, h: 800, ontop: false, focus: false });
  assert.equal(r.dock, 'docked right of Terminal');
  assert.equal(h.calls.follow, 1, 'follows the terminal while open');
  h.move({ ...RIGHT, rect: { x: 1200, y: 90, w: 560, h: 700 } });
  assert.deepEqual(h.bounds, [{ x: 1200, y: 90, w: 560, h: 700 }]);
  assert.equal(h.tp.metrics.redocks, 1);
});

test('docking: a drag on the window undocks it (stop following); close stops the loop', async () => {
  const h = dockHarness(RIGHT);
  await h.tp.openChart(view());
  h.ev({ ev: 'popup.event', popupId: 'p1', name: 'popup.drag', payload: {} });
  assert.equal(h.tp.undocked, true);
  assert.ok(h.calls.stop >= 1);
  h.move({ ...RIGHT, rect: { x: 1, y: 1, w: 560, h: 700 } });
  assert.equal(h.bounds.length, 0, 'no re-dock after the user moved it');
  h.tp.closeChart();
  assert.ok(h.calls.stop >= 2);
});

test('docking: unknown terminal → screen-right geometry, no follow loop; browser fallback → no dock text', async () => {
  const sr: DockPlacement = { rect: { x: 1360, y: 25, w: 560, h: 976 }, mode: 'screen-right', ontop: true, kind: 'unknown' };
  const h = dockHarness(sr);
  const r = await h.tp.openChart(view());
  assert.equal(h.opens[0]?.ontop, true);
  assert.equal(h.calls.follow, 0);
  assert.equal(r.dock, 'screen right (terminal not detected)');
  const b = dockHarness(RIGHT, false);
  const rb = await b.tp.openChart(view());
  assert.equal(rb.dock, null);
  assert.equal(b.calls.follow, 0, 'a browser tab is never followed');
});

test('describeDock covers every mode', () => {
  assert.match(describeDock({ ...RIGHT, mode: 'left' })!, /left of Terminal/);
  assert.match(describeDock({ ...RIGHT, mode: 'overlap', kind: 'iterm' })!, /screen edge over iTerm2/);
  assert.equal(describeDock(null), null);
});

// ------------------------------------------------------------------------------------------------ position (phase 3)
import { PaperWallet, computeFill, SOL_MINT, type PaperOrder, type SwapQuote } from '@dexterm/data';
import { PositionsLive, HELD_MEMO_MS } from '../src/live/trade.ts';

const PMINT = 'PoSiTioNMint1111111111111111111111111111pump';
function book(wallet: PaperWallet, side: 'buy' | 'sell', t: number, amountRaw: bigint, outRaw: bigint): void {
  const order: PaperOrder = { mint: PMINT, symbol: 'POS', side, decimals: 6, amountRaw, slippageBps: 50 };
  const q: SwapQuote = {
    inputMint: side === 'buy' ? SOL_MINT : PMINT, outputMint: side === 'buy' ? PMINT : SOL_MINT, inAmount: amountRaw, outAmount: outRaw, otherAmountThreshold: 1n,
    mode: 'ExactIn', slippageBps: 50, priceImpactPct: 0.1, route: ['Pump'], platformFeeBps: null, platformFeeAmount: null, usdValue: null, contextSlot: 1, source: 'jupiter-swap', fetchedAt: t,
  };
  wallet.book(order, computeFill(order, q, t));
}

test('position on the chart comes from the REAL task-1323 selector (PositionsLive over the paper ledger) + paper_trades fills', async () => {
  const NOW = 1_800_000_000_000;
  const wallet = new PaperWallet({ path: ':memory:' });
  book(wallet, 'buy', NOW - 5 * H, 500_000_000n, 2_000_000_000n);      // closed round-trip: buy 2000 POS …
  book(wallet, 'sell', NOW - 4 * H, 2_000_000_000n, 600_000_000n);     // … and sell them all (flat)
  book(wallet, 'buy', NOW - 3 * H, 1_000_000_000n, 5_000_000_000n);    // current position: buy 5000 for 1 SOL
  book(wallet, 'buy', NOW - 1 * H, 500_000_000n, 2_000_000_000n);      // + 2000 for 0.5 SOL
  book(wallet, 'sell', NOW - 30 * M, 1_000_000_000n, 250_000_000n);    // − 1000
  let now = NOW;
  const dl = { dexscreener: { tokens: async () => new Map() } } as unknown as DataLayer;
  const positions = new PositionsLive(dl, wallet, { now: () => now });
  const pushes: ChartVM[] = [];
  let onEvent: ((e: ServerEvent) => void) | undefined;
  const mgr = (o: PopupManagerOptions): PopupManager => { onEvent = o.onEvent; return { native: true, reason: 'x', hotkeyRegistered: false, port: 1, async open(req) { pushes.push(req.data as ChartVM); return { id: 'p1', kind: 'chart', native: true, setData: (d) => pushes.push(d as ChartVM), close() {}, show() {}, hide() {}, focus() {}, alwaysOnTop() {} }; }, setData() {}, close() {}, async shutdown() {} }; };
  const tp = new TokenPopups({
    theme: THEMES.cyberspace, env: { DEXTERM_HOME: '/nonexistent-1325' }, createManager: mgr, now: () => now,
    source: { series: () => null, livePrice: () => null, feed: () => 'POLL', positions, fills: (m) => wallet.trades(500).filter((t) => t.mint === m), solUsd: () => 150 },
  });
  const v = emptyView({ mint: PMINT, symbol: 'POS', name: 'pos', launchpad: 'pump.fun' }, '1h');
  v.price = 0.04; // USD per token
  await tp.openChart(v);
  const pos = pushes[0].position!;
  const held = positions.held(PMINT)!;
  assert.equal(held.tokens, 6000);
  const row = positionRow(held, 0.04, 150);
  assert.deepEqual(pos.cells, positionCells(row), 'same fields/order/formatting as the terminal row');
  assert.deepEqual(pos.cells.map((c) => c.label), ['SIDE', 'SIZE', 'VALUE', 'AVG ENTRY', 'PRICE', 'UNREALIZED', 'REALIZED']);
  assert.equal(pos.avgEntryUsd, row.avgEntryUsd);
  assert.equal(pos.sizeLabel, '6.00K POS');
  assert.equal(pos.caption, 'paper ledger · SOL $150.00');
  assert.deepEqual(pos.fills.map((f) => [f.t, f.side]), [[NOW - 3 * H, 'buy'], [NOW - H, 'buy'], [NOW - 30 * M, 'sell']], 'only the current position (the closed round-trip is not drawn)');
  assert.equal(pos.fills[0].sol, 1);
  assert.equal(pos.fills[0].tokens, 5000);
  // same tick: the next push reprices the row at the new header price
  onEvent?.({ ev: 'popup.ready', popupId: 'p1', kind: 'chart', openToReadyMs: 1, page: 'chart' });
  v.price = 0.05; now += 10; tp.syncChart(v);
  const p2 = pushes.at(-1)!.position!;
  assert.equal(p2.priceUsd, 0.05);
  assert.equal(p2.unrealizedPct, positionRow(positions.held(PMINT)!, 0.05, 150).unrealizedPct);
  assert.ok(p2.unrealizedPct! > pos.unrealizedPct!);
  // sell everything → flat → no position on the chart (after the 250 ms held() memo)
  book(wallet, 'sell', NOW, 6_000_000_000n, 1_000_000_000n);
  now += HELD_MEMO_MS + 1; tp.syncChart(v);
  assert.equal(pushes.at(-1)!.position, null);
  wallet.close();
});
