// task-1323 (UX round 3, items 5 + 6): the live token screen's POSITION row (when the coin is held)
// and the BUY/SELL FLOW panel that replaces the trade tape by default (tape behind `F`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Cache, Store, PaperWallet, computeFill, normalizePair, tokenFromPair, SOL_MINT,
  type DsRawPair, type DsTokenView, type DexScreener, type Jupiter, type SwapQuote, type PaperOrder, type DataLayer,
} from '@dexterm/data';
import {
  Canvas, THEMES, DEFAULT_KEYMAP, parseKeys, flowPanel, tradeTape, flowRatio, fmtFlowRatio, buyCells, fmtFlowTrend,
  type FlowPanelRow,
} from '@dexterm/tui';
import { makeFixtureState, type AppState } from '../src/state.ts';
import { applyKey } from '../src/main.ts';
import { emptyView, type LiveTrade, type TokenView } from '../src/live/token.ts';
import { renderTokenLive } from '../src/live/screens/token-live.ts';
import { PositionsLive, positionRow, heldFromPaper, HELD_MEMO_MS, type HeldPosition } from '../src/live/trade.ts';
import {
  FlowTracker, buyShare, trendCell, fmtWait, tapeWindow, prevSample, thinSamples, DS_TOKEN_CACHE_NS, TAPE_CAP, type FlowSample,
} from '../src/live/flow.ts';
import type { LiveContext } from '../src/live/index.ts';
import { fmtUsdFine, signedUsd, signedPctOf } from '../src/screens/positions.ts';

globalThis.fetch = (async (input: unknown) => { throw new Error(`network access blocked in tests: ${String(input)}`); }) as typeof fetch;

const NOW = 1_760_000_000_000;
const MINT = 'FLoWTesT1111111111111111111111111111111pump';
const OTHER = 'NotHeLd11111111111111111111111111111111pump';

// ------------------------------------------------------------------ item 5: position row math

const held = (over: Partial<HeldPosition> = {}): HeldPosition => ({
  mint: MINT, symbol: 'FLOW', side: 'long', tokens: 5000, costSol: 1, avgEntrySol: 0.0002, realizedSol: 0, markSol: null, stopUsd: null, targetUsd: null, ...over,
});

test('position row: size in tokens and USD, entry/price in USD, unrealized $ and % at the live tick', () => {
  const r = positionRow(held(), 0.036, 150);
  assert.equal(r.tokens, 5000);
  assert.equal(r.priceUsd, 0.036);
  assert.ok(Math.abs(r.priceSol! - 0.00024) < 1e-12, 'tick USD / SOL USD = SOL per token');
  assert.ok(Math.abs(r.valueUsd! - 180) < 1e-9, '5000 × $0.036');
  assert.ok(Math.abs(r.valueSol! - 1.2) < 1e-9);
  assert.ok(Math.abs(r.avgEntryUsd! - 0.03) < 1e-12, '0.0002 SOL × $150');
  assert.ok(Math.abs(r.unrealizedSol! - 0.2) < 1e-9);
  assert.ok(Math.abs(r.unrealizedUsd! - 30) < 1e-9);
  assert.ok(Math.abs(r.unrealizedPct! - 0.2) < 1e-12, 'fraction of cost');
  assert.equal(r.basis, 'tick');
  assert.equal(r.realizedSol, 0);
  assert.equal(r.stopUsd, null);
  assert.equal(r.stopDistPct, null);
});

test('position row: realized PnL in USD, stop/target distance as a fraction of the price', () => {
  const r = positionRow(held({ realizedSol: -0.05, stopUsd: 0.033, targetUsd: 0.045 }), 0.036, 150);
  assert.ok(Math.abs(r.realizedUsd! + 7.5) < 1e-9);
  assert.ok(Math.abs(r.stopDistPct! - (0.033 - 0.036) / 0.036) < 1e-12);
  assert.ok(r.stopDistPct! < 0, 'stop below the price reads negative');
  assert.ok(Math.abs(r.targetDistPct! - 0.25) < 1e-12);
  assert.equal(signedPctOf(r.targetDistPct!), '+25.0%');
  assert.equal(signedPctOf(r.stopDistPct!), '-8.3%');
});

test('position row: short side inverts the PnL; no SOL/USD falls back to the SOL mark; no price at all = basis none', () => {
  const s = positionRow(held({ side: 'short' }), 0.036, 150);
  assert.ok(Math.abs(s.unrealizedSol! + 0.2) < 1e-9);
  const noSol = positionRow(held({ markSol: 0.00025 }), 0.036, null);
  assert.equal(noSol.priceSol, 0.00025, 'SOL ledger mark when the tick cannot be converted');
  assert.equal(noSol.priceUsd, 0.036, 'the USD tick itself is still known');
  assert.ok(Math.abs(noSol.unrealizedSol! - 0.25) < 1e-9);
  assert.equal(noSol.unrealizedUsd, null, 'no SOL/USD → no USD PnL (never guessed)');
  assert.equal(noSol.avgEntryUsd, null);
  const none = positionRow(held(), null, 150);
  assert.equal(none.basis, 'none');
  assert.equal(none.unrealizedSol, null);
  assert.equal(none.unrealizedPct, null);
  assert.equal(none.valueUsd, null);
  assert.ok(Math.abs(none.avgEntryUsd! - 0.03) < 1e-12, 'entry still prices from the ledger');
});

test('heldFromPaper: bigint ledger → numbers; a flat position is not held', () => {
  const h = heldFromPaper({ mint: MINT, symbol: 'FLOW', decimals: 6, tokensRaw: 5_000_000_000n, costLamports: 1_000_005_000n, realizedLamports: -50_000_000n, updatedAt: NOW });
  assert.ok(h);
  assert.equal(h.tokens, 5000);
  assert.equal(h.costSol, 1.000005);
  assert.equal(h.realizedSol, -0.05);
  assert.ok(Math.abs(h.avgEntrySol! - 0.000200001) < 1e-15);
  assert.equal(h.side, 'long');
  assert.equal(heldFromPaper({ mint: MINT, symbol: 'FLOW', decimals: 6, tokensRaw: 0n, costLamports: 0n, realizedLamports: 10n, updatedAt: NOW }), null);
});

test('usd formatting keeps cents for position-sized amounts', () => {
  assert.equal(fmtUsdFine(192.5), '$192.50');
  assert.equal(fmtUsdFine(1234), '$1.23K');
  assert.equal(signedUsd(29.99925), '+$30.00');
  assert.equal(signedUsd(-3.1), '-$3.10');
});

/** A paper wallet holding 5000 FLOW bought for 1 SOL (+ the 5000-lamport simulated fee). */
function walletWithBuy(): PaperWallet {
  const wallet = new PaperWallet({ path: ':memory:' });
  const order: PaperOrder = { mint: MINT, symbol: 'FLOW', side: 'buy', decimals: 6, amountRaw: 1_000_000_000n, slippageBps: 50 };
  const q: SwapQuote = {
    inputMint: SOL_MINT, outputMint: MINT, inAmount: 1_000_000_000n, outAmount: 5_000_000_000n, otherAmountThreshold: 4_975_000_000n,
    mode: 'ExactIn', slippageBps: 50, priceImpactPct: 0.1, route: ['Pump'], platformFeeBps: null, platformFeeAmount: null, usdValue: 150,
    contextSlot: 1, source: 'jupiter-swap', fetchedAt: NOW,
  };
  wallet.book(order, computeFill(order, q, NOW));
  return wallet;
}

test('PositionsLive is a PositionSource: held() reads the paper ledger, memoized per frame burst', () => {
  const wallet = walletWithBuy();
  let now = NOW;
  const src = new PositionsLive({} as DataLayer, wallet, { now: () => now });
  assert.equal(src.kind, 'paper');
  const h = src.held(MINT);
  assert.ok(h);
  assert.equal(h.tokens, 5000);
  assert.equal(h.costSol, 1.000005);
  assert.equal(src.held(OTHER), null, 'not held → null (the screen draws nothing)');
  assert.equal(src.solUsd(), null);
  src.setSolPrice(151.25);
  assert.equal(src.solUsd(), 151.25);
  // a second fill inside the memo window is not seen until it lapses
  const order: PaperOrder = { mint: OTHER, symbol: 'OTH', side: 'buy', decimals: 6, amountRaw: 100_000_000n, slippageBps: 50 };
  const q: SwapQuote = { inputMint: SOL_MINT, outputMint: OTHER, inAmount: 100_000_000n, outAmount: 1_000_000n, otherAmountThreshold: 1n, mode: 'ExactIn', slippageBps: 50, priceImpactPct: null, route: [], platformFeeBps: null, platformFeeAmount: null, usdValue: null, contextSlot: 1, source: 'jupiter-swap', fetchedAt: NOW };
  wallet.book(order, computeFill(order, q, NOW));
  assert.equal(src.held(OTHER), null, 'memoized');
  now += HELD_MEMO_MS;
  assert.equal(src.held(OTHER)?.tokens, 1);
  wallet.close();
  now += HELD_MEMO_MS;
  assert.equal(src.held(MINT), null, 'a closed ledger reads as flat, never throws into the render');
});

test('held coin without SOL/USD: held() runs one throttled DexScreener mark pass (positions-screen source), then USD PnL is known', async () => {
  const wallet = walletWithBuy();
  let now = NOW;
  const asked: string[][] = [];
  const pairFor = (mint: string, usd: number) => ({ pair: { priceUsd: usd }, token: { mint } });
  const dl = { dexscreener: { tokens: async (m: string[]) => { asked.push(m); return new Map([[MINT, pairFor(MINT, 0.036)], [SOL_MINT, pairFor(SOL_MINT, 150)]]); } } } as unknown as DataLayer;
  let changes = 0;
  const src = new PositionsLive(dl, wallet, { now: () => now, onChange: () => { changes += 1; } });
  assert.equal(src.held(MINT)?.markSol, null);
  await new Promise((r) => setImmediate(r));
  assert.equal(asked.length, 1, 'one mark pass');
  assert.deepEqual(asked[0].sort(), [MINT, SOL_MINT].sort());
  assert.equal(src.solUsd(), 150);
  assert.ok(changes >= 1, 'redraw requested');
  const h = src.held(MINT)!;
  assert.ok(Math.abs(h.markSol! - 0.00024) < 1e-12);
  assert.ok(Math.abs(positionRow(h, null, src.solUsd()).unrealizedUsd! - (5000 * 0.036 - 1.000005 * 150)) < 1e-6, 'USD PnL from the mark alone');
  src.held(OTHER);
  now += 10_000;
  src.held(MINT);
  await new Promise((r) => setImmediate(r));
  assert.equal(asked.length, 1, 'mark + SOL known: no further passes; a flat mint never triggers one');
  wallet.close();
});

// ------------------------------------------------------------------ item 6: flow math

const bs = (buys: number, sells: number) => ({ buys, sells });

test('flow ratio/bar/trend formatting', () => {
  assert.equal(flowRatio(12, 7), 12 / 7);
  assert.equal(fmtFlowRatio(flowRatio(12, 7)), '1.71×');
  assert.equal(flowRatio(5, 0), Infinity);
  assert.equal(fmtFlowRatio(Infinity), '∞');
  assert.equal(flowRatio(0, 0), null);
  assert.equal(fmtFlowRatio(null), '—');
  assert.equal(fmtFlowRatio(flowRatio(0, 3)), '0.00×');
  assert.equal(buyCells(20, 3, 1), 15, '75 % of 20 cells');
  assert.equal(buyCells(20, 0, 0), 0);
  assert.equal(buyCells(10, 1, 2), 3);
  assert.equal(fmtFlowTrend({ dir: 1, deltaPts: 6 }), '▲ +6pt');
  assert.equal(fmtFlowTrend({ dir: -1, deltaPts: -12 }), '▼ -12pt');
  assert.equal(fmtFlowTrend({ dir: 0, deltaPts: 1 }), '◆ flat');
  assert.equal(fmtFlowTrend({ wait: '3m' }), 'wait 3m');
  assert.equal(fmtFlowTrend({ na: 'no trades' }), 'no trades');
});

test('trend: buy-share change in points vs the previous window; flat under 2 pt; no trades = n/a', () => {
  assert.equal(buyShare(bs(3, 1)), 0.75);
  assert.equal(buyShare(bs(0, 0)), null);
  assert.deepEqual(trendCell(bs(60, 40), bs(50, 50)), { dir: 1, deltaPts: 10 });
  assert.deepEqual(trendCell(bs(40, 60), bs(50, 50)), { dir: -1, deltaPts: -10 });
  assert.deepEqual(trendCell(bs(51, 49), bs(50, 50)), { dir: 0, deltaPts: 1 });
  assert.deepEqual(trendCell(bs(0, 0), bs(50, 50)), { na: 'no trades' });
  assert.deepEqual(trendCell(bs(5, 5), null), { na: 'no trades' });
  assert.equal(fmtWait(45_000), '45s');
  assert.equal(fmtWait(170_000), '3m');
  assert.equal(fmtWait(5 * 3_600_000 + 1), '6h');
  assert.equal(fmtWait(0), '1s', 'never says 0 while still waiting');
});

const trade = (ageS: number, side: 'buy' | 'sell', usd: number, anchor = NOW): LiveTrade => ({ t: anchor - ageS * 1000, side, usd, price: 0.036, wallet: 'W'.repeat(44) });

test('1m from the tape: counts and USD by side in the last 60 s; previous minute; partial when the full tape is too short', () => {
  const tape = [trade(5, 'buy', 100), trade(20, 'buy', 50), trade(59, 'sell', 30), trade(61, 'sell', 10), trade(90, 'buy', 5), trade(130, 'sell', 1)];
  const cur = tapeWindow(tape, NOW - 60_000, Infinity);
  assert.deepEqual(cur, { buys: 2, sells: 1, buyUsd: 150, sellUsd: 30, complete: true });
  const prev = tapeWindow(tape, NOW - 120_000, NOW - 60_000);
  assert.deepEqual(prev, { buys: 1, sells: 1, buyUsd: 5, sellUsd: 10, complete: true });
  // a full tape (TAPE_CAP trades) all inside the last 30 s does not reach back a minute
  const busy = Array.from({ length: TAPE_CAP }, (_, i) => trade(i * 0.5, i % 3 ? 'buy' : 'sell', 1));
  const b = tapeWindow(busy, NOW - 60_000, Infinity);
  assert.equal(b.buys + b.sells, TAPE_CAP);
  assert.equal(b.complete, false);
});

test('previous-window lookup: closest sample one window back within ±25 %, else how long to wait', () => {
  const s = (ageS: number): FlowSample => ({ t: NOW - ageS * 1000, txns: { m5: bs(ageS, 1), h1: bs(1, 1), h6: bs(1, 1), h24: bs(1, 1) }, volume: { m5: 1, h1: 1, h6: 1, h24: 1 } });
  const ring = [s(400), s(310), s(290), s(120), s(0)];
  const p = prevSample(ring, NOW, 300_000);
  assert.ok('sample' in p);
  assert.equal(p.sample.t, NOW - 310_000, "290 s and 310 s tie at 10 s; the first (older) one in ring order wins");
  const young = prevSample([s(120), s(0)], NOW, 300_000);
  assert.ok('waitMs' in young);
  assert.equal(young.waitMs, 225_000 - 120_000, 'the 120 s sample qualifies at 225 s (0.75 × 5m)');
  const fresh = prevSample([s(0)], NOW, 3_600_000);
  assert.ok('waitMs' in fresh);
  assert.equal(fmtWait(fresh.waitMs), '45m');
});

test('ring thinning keeps the newest dense and bounds a day of 10 s samples', () => {
  const day: FlowSample[] = [];
  for (let t = NOW - 86_400_000; t <= NOW; t += 10_000) day.push({ t, txns: { m5: bs(1, 1), h1: bs(1, 1), h6: bs(1, 1), h24: bs(1, 1) }, volume: { m5: null, h1: null, h6: null, h24: null } });
  const thin = thinSamples(day);
  assert.ok(thin.length < 500, `kept ${thin.length} of ${day.length}`);
  assert.equal(thin[thin.length - 1].t, NOW, 'newest kept');
  // a 5m and a 24h look-back still find a sample after thinning
  assert.ok('sample' in prevSample(thin, NOW, 300_000));
  assert.ok('sample' in prevSample(thin, NOW, 86_400_000));
});

function rawPair(m5: [number, number], h24: [number, number], over: Partial<DsRawPair> = {}): DsRawPair {
  return {
    chainId: 'solana', dexId: 'pumpswap', pairAddress: 'PaiR1111111111111111111111111111111111111111', baseToken: { address: MINT, name: 'Flow', symbol: 'FLOW' },
    quoteToken: { address: SOL_MINT, name: 'SOL', symbol: 'SOL' }, priceUsd: '0.036', priceNative: '0.00024',
    txns: { m5: { buys: m5[0], sells: m5[1] }, h1: { buys: 300, sells: 200 }, h6: { buys: 1500, sells: 1500 }, h24: { buys: h24[0], sells: h24[1] } },
    volume: { m5: 4200, h1: 51_000, h6: 300_000, h24: 1_250_000 }, liquidity: { usd: 90_000 }, ...over,
  };
}

function cacheWithPair(cache: Cache, m5: [number, number], h24: [number, number], fetchedAt: number): void {
  const raw = rawPair(m5, h24);
  const view: DsTokenView = { pair: normalizePair(raw, fetchedAt), token: tokenFromPair(raw, fetchedAt) };
  cache.set(DS_TOKEN_CACHE_NS, MINT, view, { ttlMs: 10_000, source: 'dexscreener', fetchedAt });
}

test('Store.enrich caches the DexScreener view where the flow panel reads it (namespace pinned)', async () => {
  const cache = new Cache({ path: ':memory:' });
  const ds = { tokens: async (m: string[]) => new Map(m.map((x) => [x, { pair: normalizePair(rawPair([10, 5], [2400, 2000]), NOW), token: tokenFromPair(rawPair([10, 5], [2400, 2000]), NOW) }])) } as unknown as DexScreener;
  const jup = { search: async () => [], price: async () => new Map() } as unknown as Jupiter;
  const store = new Store({ cache, dexscreener: ds, jupiter: jup });
  await store.enrich([MINT]);
  const flow = new FlowTracker();
  flow.syncFromCache(cache, MINT);
  assert.equal(flow.samples(MINT).length, 1);
  assert.deepEqual(flow.samples(MINT)[0].txns.m5, { buys: 10, sells: 5 });
});

test('FlowTracker rows: 1m from the tape, 5m..24h from DexScreener; wait label until a window-old sample exists; then arrows', () => {
  const cache = new Cache({ path: ':memory:' });
  let wall = 0;
  const flow = new FlowTracker({ clock: () => wall, minReadMs: 1000 });
  const tapePanel = { state: 'ok' as const, via: 'geckoterminal', reason: null, fetchedAt: NOW, stale: false };
  const tape = { trades: [trade(5, 'buy', 100), trade(20, 'buy', 50), trade(59, 'sell', 30), trade(61, 'sell', 10), trade(90, 'buy', 5)], panel: tapePanel };

  cacheWithPair(cache, [10, 10], [2000, 2000], NOW - 300_000);
  flow.syncFromCache(cache, MINT);
  cacheWithPair(cache, [30, 10], [2400, 2000], NOW);
  flow.syncFromCache(cache, MINT); // throttled: same wall time
  assert.equal(flow.samples(MINT).length, 1, 'cache reads are throttled per mint');
  wall += 1000;
  flow.syncFromCache(cache, MINT);
  flow.syncFromCache(cache, MINT);
  wall += 1000;
  flow.syncFromCache(cache, MINT); // same fetchedAt → ignored
  assert.equal(flow.samples(MINT).length, 2);

  const rows = flow.rows(MINT, tape, NOW);
  assert.deepEqual(rows.map((r) => r.label), ['1m', '5m', '1h', '6h', '24h'], 'at least the four asked-for windows');
  const [m1, m5, h1, , h24] = rows;
  assert.equal(m1.buys, 2);
  assert.equal(m1.sells, 1);
  assert.equal(m1.buyUsd, 150);
  assert.equal(m1.sellUsd, 30);
  assert.deepEqual(m1.trend, { dir: 1, deltaPts: 17 }, '67 % buys vs 50 % the minute before');
  assert.equal(m5.buys, 30);
  assert.equal(m5.sells, 10);
  assert.equal(m5.volUsd, 4200);
  assert.equal(m5.buyUsd, null, 'DexScreener does not split volume by side');
  assert.deepEqual(m5.trend, { dir: 1, deltaPts: 25 }, '75 % vs 50 % five minutes earlier');
  assert.ok('wait' in h1.trend, '1h has no hour-old sample yet');
  assert.equal(fmtFlowTrend(h1.trend), "wait 40m", '45 m (0.75 h) minus the 5 m of history');
  assert.equal(h24.buys, 2400);
  assert.equal(h24.volUsd, 1_250_000);
  assert.match(flow.caption(MINT, NOW + 8000), /^dexscreener 8s · 1m from tape$/);

  // no DexScreener sample yet / tape still loading: labelled, never invented
  const empty = new FlowTracker().rows(OTHER, { trades: [], panel: { state: 'loading', via: null, reason: null, fetchedAt: null, stale: false } }, NOW);
  assert.equal(empty[0].note, 'loading tape…');
  assert.equal(empty[1].note, 'no dexscreener pair yet');

  // a full tape: covering < 1 min → counts are a lower bound ('+') and no trend; covering 1–2 min →
  // exact counts but the previous minute is cut, so no comparison either
  const okPanel = { state: 'ok' as const, via: 'geckoterminal', reason: null, fetchedAt: NOW, stale: false };
  const short = new FlowTracker().rows(MINT, { trades: Array.from({ length: TAPE_CAP }, (_, i) => trade(i * 0.5, 'buy', 1)), panel: okPanel }, NOW)[0];
  assert.equal(short.partial, true);
  assert.equal(short.buyUsd, null, 'no per-side USD from a truncated window');
  assert.deepEqual(short.trend, { na: 'partial' });
  const mid = new FlowTracker().rows(MINT, { trades: Array.from({ length: TAPE_CAP }, (_, i) => trade(i * 1.5, i % 2 ? 'buy' : 'sell', 1)), panel: okPanel }, NOW)[0];
  assert.equal(mid.partial, false);
  assert.equal((mid.buys ?? 0) + (mid.sells ?? 0), 40, 'trades at 0..58.5 s');
  assert.deepEqual(mid.trend, { na: 'prev n/a' });
});

// ------------------------------------------------------------------ widgets

test('flowPanel draws a header and one row per window; volume drops before the bar on a narrow panel', () => {
  const rows: FlowPanelRow[] = [
    { label: '1m', buys: 12, sells: 7, buyUsd: 1234, sellUsd: 800, volUsd: 2034, trend: { dir: 1, deltaPts: 6 } },
    { label: '5m', buys: 30, sells: 10, buyUsd: null, sellUsd: null, volUsd: 4200, trend: { wait: '3m' } },
    { label: '1h', buys: null, sells: null, buyUsd: null, sellUsd: null, volUsd: null, trend: { na: '—' }, note: 'no dexscreener pair yet' },
  ];
  const wide = new Canvas(70, 5, THEMES.midnight);
  assert.equal(flowPanel(wide, 0, 0, 70, 5, rows), 4);
  const lines = wide.toPlain().split('\n');
  assert.match(lines[0], /^WIN +BUYS SELLS buy ━ sell +B:S +USD VOL B\/S TREND$/);
  assert.match(lines[1], /^1m +12 +7 ━+ 1\.71× +\$1\.2K\/\$800 ▲ \+6pt$/);
  assert.match(lines[2], /^5m +30 +10 ━+ 3\.00× +\$4\.2K wait 3m$/);
  assert.match(lines[3], /^1h +no dexscreener pair yet$/);
  const narrow = new Canvas(36, 3, THEMES.midnight);
  flowPanel(narrow, 0, 0, 36, 3, rows);
  const n = narrow.toPlain().split('\n');
  assert.doesNotMatch(n[0], /USD VOL/, 'volume column dropped');
  assert.match(n[1], /1\.71× ▲ \+6pt$/);
  // the bar is two-tone: 12 of 19 trades are buys
  const bar = lines[1].match(/━+/)![0].length;
  assert.equal(buyCells(bar, 12, 7), Math.round(12 / 19 * bar));
});

test('tradeTape lists trades newest first: age, side, USD, price, wallet', () => {
  const c = new Canvas(46, 3, THEMES.midnight);
  const n = tradeTape(c, 0, 0, 46, 2, [trade(5, 'buy', 1200), trade(30, 'sell', 80), trade(40, 'buy', 1)], NOW);
  assert.equal(n, 2, 'clipped to the height');
  const lines = c.toPlain().split('\n');
  assert.match(lines[0], /^ +5s BUY +\$1\.2K +\$0\.0360 +WWW…WWW$/);
  assert.match(lines[1], /^ +30s SELL +\$80 +\$0\.0360 +WWW…WWW$/);
});

// ------------------------------------------------------------------ the live token screen

interface Harness { state: AppState; view: TokenView; positions: PositionsLive; wallet: PaperWallet; cache: Cache; setTick(px: number | null): void }

function harness(opts: { held: boolean }): Harness {
  const wallet = opts.held ? walletWithBuy() : new PaperWallet({ path: ':memory:' });
  const positions = new PositionsLive({} as DataLayer, wallet, { now: () => NOW });
  const cache = new Cache({ path: ':memory:' });
  cacheWithPair(cache, [30, 10], [2400, 2000], NOW - 2000);
  const view = emptyView({ mint: MINT, symbol: 'FLOW', name: 'Flow Test', launchpad: 'pump.fun', price: 0.036 });
  view.trades = [trade(5, 'buy', 100), trade(20, 'buy', 50), trade(59, 'sell', 30), trade(61, 'sell', 10), trade(90, 'buy', 5)];
  view.panels.trades = { state: 'ok', via: 'geckoterminal', reason: null, fetchedAt: NOW, stale: false };
  view.panels.market = { state: 'ok', via: 'ds', reason: null, fetchedAt: NOW, stale: false };
  let tick: number | null = null;
  const dl = { cache } as unknown as DataLayer;
  const live = {
    dl, positions, token: { dl, view }, rpc: { provider: 'helius', basis: 'test' }, fastLane: null,
    badgeFor: () => (tick !== null ? 'LIVE' : 'POLL'), livePrice: () => tick, watch: { has: () => false }, creditsStatus: () => undefined,
  } as unknown as LiveContext;
  const state = makeFixtureState({ screen: 'token', theme: THEMES.midnight, calm: true });
  state.screener.source = 'live';
  state.live = live;
  state.sol = { price: 150, chg24: 0 };
  state.now = new Date(NOW);
  return { state, view, positions, wallet, cache, setTick: (px) => { tick = px; (live as unknown as { fastLane: unknown }).fastLane = px !== null ? {} : null; } };
}

function render(h: Harness, w = 176, ht = 48): string {
  const c = new Canvas(w, ht, THEMES.midnight);
  c.fill(0, 0, w, ht, ' ', { bg: THEMES.midnight.bg });
  renderTokenLive(c, h.state, h.view);
  return c.toPlain();
}

test('token screen, HELD coin: a POSITION row under the chart with size, value, entry, price, unrealized $/%', () => {
  const h = harness({ held: true });
  const out = render(h);
  const lines = out.split('\n');
  const title = lines.findIndex((l) => l.includes('◈ POSITION · PAPER'));
  const chartTop = lines.findIndex((l) => l.includes('FLOW/USD · 1h'));
  assert.ok(title > chartTop, 'position panel sits below the chart');
  assert.match(lines[title], /paper ledger · SOL \$150\.00/);
  assert.match(lines[title + 1], /SIDE +SIZE +VALUE +AVG ENTRY +PRICE +UNREALIZED/);
  // 5000 FLOW at $0.036 = $180; cost 1.000005 SOL ($150.00) → +$30.00 / +20.0 %
  assert.match(lines[title + 2], /LONG +5\.00K FLOW +\$180\.00 +\$0\.0300 +\$0\.0360 +\+\$30\.00 \+20\.0%/);
  assert.doesNotMatch(lines[title + 1], /(?<!UN)REALIZED|STOP|TARGET/, 'no realized/stop/target clutter when there is none');
  assert.match(lines[title + 3], /^╰/);
  assert.match(lines[title + 4], /ON-CHAIN/, 'the stats panels follow directly');
});

test('token screen, HELD coin: the row moves with the live tick the header shows', () => {
  const h = harness({ held: true });
  h.setTick(0.045);
  const out = render(h);
  assert.match(out.split('\n')[3], /\$0\.0450 +LIVE/, 'header shows the fast-lane tick');
  assert.match(out, /LONG +5\.00K FLOW +\$225\.00 +\$0\.0300 +\$0\.0450 +\+\$75\.00 \+50\.0%/, 'same tick prices the position');
});

test('token screen, NOT held: nothing extra — no position panel, chart keeps its full height', () => {
  const h = harness({ held: false });
  const out = render(h);
  assert.doesNotMatch(out, /POSITION|LONG|UNREALIZED/);
  const lines = out.split('\n');
  const chartTop = lines.findIndex((l) => l.includes('FLOW/USD · 1h'));
  const onchain = lines.findIndex((l) => l.includes('ON-CHAIN'));
  assert.equal(onchain - chartTop, Math.max(10, Math.floor((47 - chartTop) * 0.46)), 'same chart height as before task-1323');
  const heldOut = render(harness({ held: true })).split('\n');
  assert.equal(heldOut.findIndex((l) => l.includes('ON-CHAIN')) - heldOut.findIndex((l) => l.includes('FLOW/USD · 1h')), Math.max(10, Math.floor((47 - chartTop - 4) * 0.46)) + 4, 'held: chart shares its height with the 4-row panel');
});

test('token screen: BUY/SELL FLOW is the default panel; F toggles the tape in place and back', () => {
  const h = harness({ held: false });
  assert.equal(h.state.tokenTape, undefined, 'tape off by default');
  const flow = render(h, 176, 48);
  assert.match(flow, /BUY\/SELL FLOW +dexscreener 2s · 1m from tape/);
  assert.match(flow, /1m +2 +1 .*2\.00× +\$150\/\$30 +▲ \+17pt/);
  assert.match(flow, /5m +30 +10 .*3\.00× +\$4\.2K +wait 4m/);
  assert.match(flow, /24h +2400 +2000 .*1\.20× +\$1\.25M +wait 18h/);
  assert.match(flow, /trend = buy share vs the previous window/);
  assert.doesNotMatch(flow, /TAPE|geckoterminal · 20s poll/);
  assert.match(flow, / F  tape /, 'footer names the key');

  const F = parseKeys('F')[0];
  assert.equal(DEFAULT_KEYMAP.resolve(F, 'token'), 'tape.toggle');
  assert.equal(DEFAULT_KEYMAP.resolve(parseKeys('T')[0], 'token'), 'open.tg', 'T keeps opening Telegram');
  applyKey(h.state, F, []);
  assert.equal(h.state.tokenTape, true);
  const tape = render(h, 176, 48);
  assert.match(tape, /TAPE +geckoterminal · 20s poll/);
  assert.match(tape, /5s BUY +\$100 +\$0\.0360/);
  assert.match(tape, / 2m BUY +\$5 /);
  assert.doesNotMatch(tape, /BUY\/SELL FLOW/);
  assert.match(tape, / F  flow /);
  h.view.trades = [...h.view.trades]; // a data refresh does not reset the toggle
  assert.match(render(h, 176, 48), /TAPE/);
  applyKey(h.state, F, []);
  assert.equal(h.state.tokenTape, false);
  assert.match(render(h, 176, 48), /BUY\/SELL FLOW/);
  // F means nothing elsewhere
  const s2 = makeFixtureState({ screen: 'screener' });
  applyKey(s2, F, []);
  assert.equal(s2.tokenTape, undefined);
});

test('token screen fits at 120×40 with both panels (held + flow) and every row is within the width', () => {
  const h = harness({ held: true });
  for (const [w, ht] of [[176, 48], [120, 40], [100, 30], [90, 40]] as const) {
    const out = render(h, w, ht);
    const lines = out.split('\n');
    assert.equal(lines.length, ht);
    for (const l of lines) assert.ok([...l].length <= w, `row wider than ${w}`);
    assert.match(out, /◈ POSITION · PAPER/, `position shown at ${w}×${ht}`);
    if (w >= 100) assert.match(out, /BUY\/SELL FLOW/, `flow shown at ${w}×${ht}`);
  }
  const std = render(h, 120, 40);
  assert.match(std, /5m +30 +10 .*3\.00× +\$4\.2K +wait 4m/, 'volume column survives at 120 cols');
});
