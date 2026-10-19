// task-1298: the live TOKEN / NEW PAIRS / WATCHLIST bindings and screens, offline. Recorded sources:
// packages/data/fixtures/task-1298-sample.json (Helius mint+holders with the key redacted, GoPlus, Gecko
// trades, RugCheck new_tokens, a 60 s PumpPortal session) and d06-sample.json (BONK pool + candles).
// Market data for the token screen is synthetic (the documented DexScreener / Jupiter shapes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FixtureStore, FakeClock, createDataLayer, replayTransport, PumpPortalClient, WatchlistStore,
  type Transport, type HttpRequest, type HttpResponse,
} from '@dexterm/data';
import { THEMES, parseKeys, type ScreenKey } from '@dexterm/tui';
import { createReplayFeed, unlimitedBuckets, ScreenerFeed } from '../src/feed.ts';
import { makeFeedState, renderFrame, headerModel, isDemoScreen } from '../src/state.ts';
import { applyAction, applyKey, parseArgs, main } from '../src/main.ts';
import { screenerView } from '../src/screener/view.ts';
import { LiveContext, TokenLive, NewPairsLive, WatchlistLive, latencyStats, percentile, renderTokenLive } from '../src/live/index.ts';

globalThis.fetch = (async (input: unknown) => { throw new Error(`network access blocked in tests: ${String(input)}`); }) as typeof fetch;

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(here, '..', '..', 'data', 'fixtures', 'live-sample.json');
const T1298 = resolve(here, '..', '..', 'data', 'fixtures', 'task-1298-sample.json');
const D06 = resolve(here, '..', '..', 'data', 'fixtures', 'd06-sample.json');
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const BONK_POOL = '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9';
const HELIUS_REDACTED = 'https://mainnet.helius-rpc.com/?api-key=REDACTED';

function json(status: number, body: unknown): HttpResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), latencyMs: 3 };
}

/** Both recordings plus synthetic market responses for BONK (tokens/v1, search, price). */
function tokenTransport(): { t: Transport; calls: string[] } {
  const a = replayTransport(FixtureStore.load(T1298));
  const b = replayTransport(FixtureStore.load(D06));
  const calls: string[] = [];
  const pair = {
    chainId: 'solana', dexId: 'orca', pairAddress: BONK_POOL, baseToken: { address: BONK, name: 'Bonk', symbol: 'Bonk' }, quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'SOL', symbol: 'SOL' },
    priceUsd: '0.0000377', priceNative: '0.00000031', txns: { m5: { buys: 10, sells: 5 }, h1: { buys: 100, sells: 80 }, h6: { buys: 600, sells: 500 }, h24: { buys: 2400, sells: 2000 } },
    volume: { m5: 1000, h1: 20000, h6: 150000, h24: 600000 }, priceChange: { m5: 0.1, h1: -1.2, h6: 3.4, h24: -5.6 }, liquidity: { usd: 423751 }, fdv: 3300000, marketCap: 3300000, pairCreatedAt: 1672531200000,
  };
  const jup = { id: BONK, name: 'Bonk', symbol: 'Bonk', decimals: 5, launchpad: null, holderCount: 1024386, organicScore: 88, isVerified: true, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 36.1, devBalancePercentage: 0.01, devMints: 1 }, usdPrice: 0.0000377, mcap: 3300000, fdv: 3300000, liquidity: 423751, stats24h: { priceChange: -5.6, holderChange: 0.2, numBuys: 2400, numSells: 2000, buyVolume: 300000, sellVolume: 300000 } };
  const t: Transport = async (req: HttpRequest) => {
    calls.push(req.url);
    const u = new URL(req.url);
    if (u.pathname.startsWith('/tokens/v1/solana/')) return json(200, [pair]);
    if (u.pathname === '/tokens/v2/search') return json(200, [jup]);
    if (u.pathname === '/price/v3') return json(200, { [BONK]: { usdPrice: 0.0000377, priceChange24h: -5.6 } });
    // d06 recorded the OHLCV without the `token` parameter the live loader adds
    if (u.pathname.includes('/ohlcv/')) { u.searchParams.delete('token'); return b({ ...req, url: u.toString() }); }
    try { return await a(req); } catch { return b(req); }
  };
  return { t, calls };
}

/** The live-sample recording serves any mint set: rewrite single-mint enrich URLs to the recorded 30-mint batch. */
function batchRewrite(store: FixtureStore): Transport {
  const inner = replayTransport(store);
  const ds = store.list().find((e) => e.url.includes('/tokens/v1/solana/'))!.url;
  const jup = store.list().find((e) => e.url.includes('/tokens/v2/search'))!.url;
  const price = store.list().find((e) => e.url.includes('/price/v3'))?.url;
  return async (req) => {
    const u = new URL(req.url);
    if (u.pathname.startsWith('/tokens/v1/solana/')) return inner({ ...req, url: ds });
    if (u.pathname === '/tokens/v2/search') return inner({ ...req, url: jup });
    if (u.pathname === '/price/v3' && price) return inner({ ...req, url: price });
    return inner(req);
  };
}

// ---------------------------------------------------------------- token

test('token live: every panel loads from recorded Helius / GoPlus / Gecko / RugCheck data and says where it came from', async () => {
  const { t, calls } = tokenTransport();
  const clock = new FakeClock(Date.parse(FixtureStore.load(T1298).recordedAt!));
  const dl = createDataLayer({ clock, transport: t, buckets: unlimitedBuckets(), rpcUrl: HELIUS_REDACTED, disabled: ['pumpfun'] });
  const changes: number[] = [];
  // candleBaseLimit 100 keeps the base fetch on the recorded limit=100 fixture; prefetch off so the
  // exact call-count assertions below stay deterministic (task-1314: base fetch + local derivation).
  const live = new TokenLive(dl, { mint: BONK, symbol: 'Bonk', name: 'Bonk', launchpad: 'unknown' }, { interval: '1h', candleLimit: 100, candleBaseLimit: 100, prefetchCandles: false, now: () => clock.now(), onChange: () => changes.push(1) });
  const p = live.load();
  // the limiter is unlimited but the clock is fake: let any sleeps run
  for (let i = 0; i < 50 && live.view.updatedAt === null; i++) await clock.advance(100);
  await p;
  const v = live.view;
  assert.equal(v.panels.market.state, 'ok');
  assert.equal(v.price, 0.0000377);
  assert.equal(v.org, 88);
  assert.equal(v.verified, true);
  assert.equal(v.pair, BONK_POOL, 'DexScreener pair address drives the chart and tape');
  assert.equal(v.panels.authorities.via, 'helius');
  assert.equal(v.mintAuth, false);
  assert.equal(v.freezeAuth, false);
  assert.equal(v.tokenProgram, 'spl-token');
  assert.equal(v.panels.holders.via, 'helius');
  assert.equal(v.holdersTop.length, 20);
  assert.equal(v.top10, 38.42, 'chain truth beats Jupiter topHoldersPercentage (36.1) once holders land');
  assert.match(v.holdersSample ?? '', /^top 20 · 50\.\d% of supply$/);
  assert.equal(v.panels.goplus.state, 'ok');
  assert.deepEqual(v.goplus?.flags, []);
  assert.equal(v.panels.candles.via, 'geckoterminal');
  assert.equal(v.candles.length, 100);
  assert.equal(v.panels.trades.via, 'geckoterminal');
  assert.equal(v.trades.length, 60);
  assert.equal(v.panels.rugcheck.state, 'error', 'RugCheck summary for BONK is not in the recordings');
  assert.equal(v.panels.rugcheck.reason, 'not in recording');
  assert.equal(v.rug, null);
  assert.equal(v.snipers, null);
  assert.equal(v.bundled, null);
  assert.deepEqual(v.flags, ['TOP10']);
  assert.ok(changes.length >= 7, 'one redraw per panel at least');
  assert.ok(calls.some((u) => u.includes('mainnet.helius-rpc.com')));
  assert.ok(!calls.some((u) => u.includes('api.mainnet-beta.solana.com')), 'Helius answered, the public fallback was never needed');
  assert.equal(dl.credits?.status().session, 3);
  // interval change refetches only candles
  const before = calls.length;
  const q = live.setInterval('1m');
  for (let i = 0; i < 20 && live.view.panels.candles.state === 'loading'; i++) await clock.advance(100);
  await q;
  assert.equal(live.view.interval, '1m');
  assert.equal(live.view.candles.length, 100);
  assert.equal(calls.length - before, 1);

  // the live token screen renders at the three widths, names its sources and carries the demo label on the analyst panel
  const feed = createReplayFeed(SAMPLE);
  await feed.refresh();
  const ctx = new LiveContext(feed.dl, { mode: 'replay', replay: feed.replayStore ?? undefined });
  const state = makeFeedState(feed, 'replay', { screen: 'token', theme: THEMES.midnight, calm: true });
  state.live = ctx;
  ctx.token = live;
  state.now = new Date(clock.now());
  for (const [w, h] of [[176, 48], [120, 40], [90, 40], [80, 24]] as const) {
    const c = renderFrame(state, w, h);
    const plain = c.toPlain();
    const lines = plain.split('\n');
    assert.equal(lines.length, h);
    for (const row of lines) assert.ok([...row].length <= w, `row wider than ${w} at ${w}×${h}`);
    assert.match(lines[0], /◉ live/, 'the token screen is live, not demo');
    assert.doesNotMatch(lines[0], /demo data/);
  }
  const wide = renderFrame(state, 176, 48).toPlain();
  assert.match(wide, /top 20 · 50\.\d% of supply · via helius/);
  assert.match(wide, /via helius · spl-token/);
  assert.match(wide, /ohlcv: geckoterminal/);
  // task-1323: the panel under the holders is BUY/SELL FLOW by default (DexScreener txns from the
  // cached pair: m5 10/5, h24 2400/2000); the raw tape is behind `F`.
  assert.match(wide, /BUY\/SELL FLOW/);
  assert.match(wide, /5m +10 +5 .*2\.00×/);
  assert.match(wide, /24h +2400 +2000 .*1\.20×/);
  assert.doesNotMatch(wide, /geckoterminal · 20s poll/, 'the tape is off by default');
  state.tokenTape = true;
  assert.match(renderFrame(state, 176, 48).toPlain(), /geckoterminal · 20s poll/, 'F brings the tape back');
  state.tokenTape = false;
  assert.match(wide, /RugCheck\S* +unavailable: not in recording/);
  assert.match(wide, /needs Helius key|M bubble map|scanning/, 'snipers/bundled never invented');
  // task-1311 (QA M5): opening a token no longer spends a dossier; the analyst panel is the live
  // "ask on demand" state, not a demo placeholder.
  assert.match(wide, /ANALYST · claude/);
  assert.match(wide, /run a full dossier/);
  assert.match(wide, /CA DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263/, 'the full contract address is shown (QA B5)');
  assert.match(wide, /9WzD…AWWM/);
  assert.ok(!wide.includes('REDACTED') && !wide.includes('api-key'), 'no URL ever reaches the screen');
  // a plain render through the generic entry point hits the same renderer
  const direct = renderFrame(state, 120, 40);
  const c2 = new (direct.constructor as new (w: number, h: number, th: typeof THEMES.midnight) => typeof direct)(120, 40, THEMES.midnight);
  renderTokenLive(c2, state, live.view);
  assert.equal(c2.toPlain(), direct.toPlain());
  ctx.close();
  feed.close();
  dl.close();
});

test('token live: with no key and a throttled public RPC the holders panel says unavailable, never a number', async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const t: Transport = async (req) => {
    const u = new URL(req.url);
    if (u.hostname === 'api.mainnet-beta.solana.com') return { status: 429, headers: { 'retry-after': '10' }, body: '', latencyMs: 1 };
    return json(404, {});
  };
  const dl = createDataLayer({ clock, transport: t, buckets: unlimitedBuckets() });
  assert.equal(dl.rpc.source, 'solana-rpc');
  assert.equal(dl.rpcFallback, null);
  assert.equal(dl.credits, null);
  const live = new TokenLive(dl, { mint: BONK, symbol: 'Bonk', name: 'Bonk', launchpad: 'unknown' }, { candleBaseLimit: 100, prefetchCandles: false, now: () => clock.now() });
  const p = live.load();
  for (let i = 0; i < 50 && live.view.updatedAt === null; i++) await clock.advance(200);
  await p;
  const v = live.view;
  assert.equal(v.panels.holders.state, 'error');
  assert.equal(v.panels.holders.reason, 'rate limited (429)');
  assert.deepEqual(v.holdersTop, []);
  assert.equal(v.top10, null);
  assert.equal(v.panels.market.state, 'error');
  const feed = createReplayFeed(SAMPLE);
  const state = makeFeedState(feed, 'replay', { screen: 'token' });
  state.live = new LiveContext(feed.dl, { mode: 'replay' });
  state.live.token = live;
  const plain = renderFrame(state, 176, 48).toPlain();
  // task-1305 (M10): a keyless user on the throttled public RPC is pointed at the free Helius key
  // (doctor walks them through it) rather than a bare 429. The 429 is still the panel's data state
  // (asserted above); it is never rendered as a holder number.
  assert.match(plain, /needs a free Helius key/);
  assert.doesNotMatch(plain, /\d+\.\d\d\s+\d/, 'no holder rows');
  state.live.close();
  feed.close();
  dl.close();
});

// ---------------------------------------------------------------- new pairs

test('new pairs live: the recorded PumpPortal session replays into 25 rows + 1 migration flag, latency is measured, screens render at 176/120/90', async () => {
  const feed = createReplayFeed(T1298);
  const store = feed.replayStore!;
  const recordedAt = Date.parse(store.recordedAt!);
  let now = recordedAt;
  const reasons: string[] = [];
  const ctx = new LiveContext(feed.dl, { mode: 'replay', replay: store, now: () => now, polls: { recent: false, enrich: false, newTokens: true } });
  ctx.onChange = (r) => reasons.push(r);
  await ctx.startFeed(0);
  const rows = ctx.newpairs.list();
  assert.equal(rows.length, 25);
  assert.ok(rows.every((r) => r.via.includes('pumpportal')));
  assert.ok(rows.every((r) => r.launchpad === 'pump.fun' || r.launchpad === 'bonk'));
  assert.ok(rows.some((r) => r.bonding !== null && r.bonding > 0), 'curve progress estimated from reserves');
  assert.equal(rows.filter((r) => r.migrated).length, 1, 'one migration in the session hit a mint we saw created');
  assert.equal(rows.filter((r) => r.mcap !== null).length, 0, 'no SOL price yet → no USD market cap invented');
  ctx.newpairs.setSolPrice(120);
  assert.ok(ctx.newpairs.list().every((r) => r.mcap === null || r.marketCapSol === null || Math.abs(r.mcap - r.marketCapSol * 120) < 1e-6));
  const st = ctx.newpairs.status();
  assert.equal(st.mode, 'replay');
  assert.equal(st.latency.n, 25);
  assert.equal(st.latency.p50, 0, 'replay delivers instantly on the fake clock');
  assert.match(st.caption, /^replay: pumpportal 25 creates · rugcheck$/);
  assert.ok(reasons.filter((r) => r === 'newpairs:create').length === 25);
  // the RugCheck new_tokens poll (recorded) attaches creator/authority facts to the rows it knows
  await ctx.newpairs.refresh(true);
  assert.equal(ctx.newpairs.errors.rugcheck, undefined);
  // render
  const state = makeFeedState(feed, 'replay', { screen: 'newpairs', theme: THEMES.midnight });
  state.live = ctx;
  state.now = new Date(now);
  for (const [w, h] of [[176, 48], [120, 40], [90, 40], [80, 24]] as const) {
    const plain = renderFrame(state, w, h).toPlain();
    const lines = plain.split('\n');
    assert.equal(lines.length, h);
    for (const row of lines) assert.ok([...row].length <= w, `row wider than ${w} at ${w}×${h}`);
    assert.match(lines[0], /◉ live/);
    assert.doesNotMatch(lines[0], /demo data/, 'new pairs are live, not demo');
  }
  const wide = renderFrame(state, 176, 48).toPlain();
  assert.match(wide, /New 25/);
  assert.match(wide, /Migrated 1/);
  assert.match(wide, /replay: pumpportal 25 creates/);
  assert.match(wide, /event→row p50 0ms/);
  assert.match(wide, /CHIP/);
  assert.match(wide, /PumpSwap at \$69K/);
  assert.match(wide, /◌ demo data · not wired yet/, 'the claude line in the spotlight is labelled');
  assert.match(wide, /SNIPE/);
  // keys: j/k move within the live rows, enter opens the live token detail
  const stack: ScreenKey[] = [];
  applyKey(state, parseKeys('j')[0], stack);
  assert.equal(state.selected, 1);
  applyKey(state, parseKeys('G')[0], stack);
  assert.equal(state.selected, 24);
  applyKey(state, parseKeys('\r')[0], stack);
  assert.equal(state.screen, 'token');
  assert.ok(ctx.token);
  assert.equal(ctx.token!.view.mint, rows[24].mint);
  ctx.close();
  feed.close();
});

test('new pairs live: with the push feed down, rows come from the Jupiter recent poll and the header says degraded', async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const recent = [{ id: 'Mint1pump', name: 'one', symbol: 'ONE', launchpad: 'pump.fun', holderCount: 12, organicScore: 5, usdPrice: 0.001, mcap: 1000, liquidity: 500, firstPool: { id: 'P', createdAt: new Date(clock.now() - 60_000).toISOString() }, stats5m: { numBuys: 3, numSells: 1, priceChange: 2 }, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, devBalancePercentage: 7 } }];
  const t: Transport = async (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/tokens/v2/recent') return json(200, recent);
    return json(500, {});
  };
  const dl = createDataLayer({ clock, transport: t, buckets: unlimitedBuckets() });
  const live = new NewPairsLive(dl, { now: () => clock.now(), polls: { recent: true, newTokens: false, enrich: false } });
  const client = new PumpPortalClient({ url: 'wss://x', clock, health: dl.health, ws: () => { throw new Error('ECONNREFUSED'); } });
  live.attach(client, 'live');
  live.start();
  await clock.advance(3_100); // three failed connects → degraded
  assert.equal(dl.health.state('pumpportal'), 'degraded');
  await live.refresh(true);
  const rows = live.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'ONE');
  assert.equal(rows[0].latencyMs, null, 'polled rows carry no push latency');
  assert.deepEqual(rows[0].flags, ['DEV']);
  const st = live.status();
  assert.match(st.caption, /pumpportal reconnecting in \ds · polling jup recent · jup recent/);
  assert.equal(st.headerStatus, '◐ degraded: pumpportal');
  assert.equal(st.latency.n, 0);
  live.stop();
  dl.close();
  assert.deepEqual(latencyStats([5, 1, 9, 3]), { n: 4, p50: 3, p95: 9, max: 9 });
  assert.equal(percentile([], 50), null);
});

// ---------------------------------------------------------------- watchlist

test('watchlist live: w adds from the screener, proposals need y, d removes, the list survives a reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-1298-cli-'));
  const dbPath = join(dir, 'dexterm.db');
  try {
    const store = FixtureStore.load(SAMPLE);
    const dl = createDataLayer({ transport: batchRewrite(store), buckets: unlimitedBuckets(), disabled: ['pumpfun'] });
    const feed = new ScreenerFeed(dl, { now: () => now });
    let now = Date.parse(store.recordedAt!) + 2000;
    await feed.refresh();
    const ctx = new LiveContext(feed.dl, { mode: 'replay', dbPath, now: () => now });
    const state = makeFeedState(feed, 'replay', { screen: 'screener', selected: 2 });
    state.live = ctx;
    const stack: ScreenKey[] = [];
    const row = screenerView(state.screener)[2]; // the highlighted row is the sorted view's
    applyKey(state, parseKeys('w')[0], stack);
    assert.ok(ctx.watch.has(row.mint));
    assert.match(state.screener.notice ?? '', /watching \$/);
    assert.equal(ctx.watch.proposals().length, 2, 'two price proposals, nothing armed');
    assert.equal(ctx.watch.armed().length, 0);
    // y arms the first proposal, x dismisses the next
    applyKey(state, parseKeys('y')[0], stack);
    assert.equal(ctx.watch.armed().length, 1);
    applyKey(state, parseKeys('x')[0], stack);
    assert.equal(ctx.watch.proposals().length, 0);
    // b proposes a liquidity alert for the highlighted row
    applyKey(state, parseKeys('b')[0], stack);
    assert.equal(ctx.watch.proposals().length, 1);
    assert.equal(ctx.watch.proposals()[0].kind, 'liq');
    // the watchlist screen renders the live list (not the fixtures) with the proposal panel
    state.screen = 'watchlist';
    now += 5_000;
    await ctx.watch.refresh();
    const wrow = ctx.watch.list()[0];
    assert.equal(wrow.entry.mint, row.mint);
    assert.ok(wrow.row, 'price refreshed through the replayed store');
    assert.ok(Math.abs(wrow.pnlPct ?? 1) < 1e-9, 'entry = current price right after adding');
    state.now = new Date(now);
    for (const [w, h] of [[176, 48], [120, 40], [90, 40]] as const) {
      const plain = renderFrame(state, w, h).toPlain();
      const lines = plain.split('\n');
      assert.equal(lines.length, h);
      for (const r of lines) assert.ok([...r].length <= w);
      assert.doesNotMatch(lines[0], /demo data/);
      assert.match(plain, new RegExp(row.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    const wide = renderFrame(state, 176, 48).toPlain();
    assert.match(wide, /1 token · PnL vs entry · 1 armed · 1 proposed/);
    assert.match(wide, /ALERT PROPOSALS/);
    assert.match(wide, /liq < /);
    assert.match(wide, /added to watchlist/);
    assert.match(wide, /analyst digest: ◌ demo data/);
    // d removes the highlighted row
    applyKey(state, parseKeys('d')[0], stack);
    assert.equal(ctx.watch.list().length, 0);
    assert.match(renderFrame(state, 120, 40).toPlain(), /watchlist is empty/);
    // persistence: add again, close, reopen
    applyAction(state, 'screen.screener', stack);
    state.selected = 2;
    applyKey(state, parseKeys('w')[0], stack);
    ctx.close();
    const again = new WatchlistStore({ path: dbPath });
    assert.deepEqual(again.list().map((e) => e.mint), [row.mint]);
    assert.equal(again.rules('proposed').length, 2);
    again.close();
    feed.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watchlist live: armed rules fire into the alert log on refresh and the notice says so', async () => {
  const clock = new FakeClock(1_700_000_000_000);
  let price = 1;
  const t: Transport = async (req) => {
    const u = new URL(req.url);
    if (u.pathname.startsWith('/tokens/v1/solana/')) return json(200, [{ chainId: 'solana', dexId: 'x', pairAddress: 'P', baseToken: { address: 'M1', name: 'one', symbol: 'ONE' }, quoteToken: { address: 'Q', name: 'q', symbol: 'Q' }, priceUsd: String(price), liquidity: { usd: 1000 }, marketCap: 1e6 }]);
    if (u.pathname === '/tokens/v2/search') return json(200, []);
    if (u.pathname === '/price/v3') return json(200, {});
    return json(500, {});
  };
  const dl = createDataLayer({ clock, transport: t, buckets: unlimitedBuckets() });
  const store = new WatchlistStore({ clock });
  const live = new WatchlistLive(dl, store, { now: () => clock.now() });
  live.add({ mint: 'M1', symbol: 'ONE', name: 'one', launchpad: 'unknown', price: 1 });
  live.confirm('M1'); // +25 %
  live.confirm('M1'); // -25 %
  assert.equal(live.armed().length, 2);
  await live.refresh();
  assert.equal(live.events().filter((e) => e.kind === 'price').length, 0);
  price = 1.3;
  await clock.advance(11_000); // past the pairs TTL
  await live.refresh();
  const fired = live.events().filter((e) => e.kind === 'price');
  assert.equal(fired.length, 1);
  assert.match(fired[0].text, /ONE price > \$1\.25 \(now \$1\.30\)/);
  assert.match(live.notice ?? '', /alert: ONE price/);
  assert.equal(live.armed().length, 1, 'fired rules disarm');
  // a pair seconds old has no price yet but a SOL-denominated market cap: proposals go on mcap
  live.add({ mint: 'M2', symbol: 'NEW', name: 'new', launchpad: 'pump.fun', price: null, mcap: 4000 });
  assert.deepEqual(live.proposals('M2').map((p) => [p.kind, p.op, p.value]), [['mcap', '>', 8000], ['mcap', '<', 2000]]);
  assert.match(live.notice ?? '', /2 alert proposals/);
  live.add({ mint: 'M3', symbol: 'BARE', name: 'bare', launchpad: 'unknown', price: null, mcap: null });
  assert.equal(live.proposals('M3').length, 0);
  assert.match(live.notice ?? '', /no price or mcap yet/);
  store.close();
  dl.close();
});

// ---------------------------------------------------------------- header, args, one-shot

test('header: live screens say live; the analyst (and any screen without its live binding) says demo data', async () => {
  const feed = createReplayFeed(SAMPLE);
  await feed.refresh();
  const state = makeFeedState(feed, 'replay');
  for (const s of ['newpairs', 'watchlist', 'token', 'analyst'] as const) { state.screen = s; assert.equal(isDemoScreen(state), true, `${s} without bindings`); }
  state.live = new LiveContext(feed.dl, { mode: 'replay' });
  state.screen = 'newpairs';
  assert.equal(isDemoScreen(state), false);
  assert.equal(headerModel(state).status, undefined);
  assert.match(headerModel(state).feedLabel ?? '', /replay: pumpportal 0 creates/);
  state.screen = 'watchlist';
  assert.equal(isDemoScreen(state), false);
  state.screen = 'token';
  assert.equal(isDemoScreen(state), true, 'no token open yet');
  state.live.openToken({ mint: BONK, symbol: 'Bonk', name: 'Bonk', launchpad: 'unknown' });
  assert.equal(isDemoScreen(state), false);
  state.screen = 'analyst';
  assert.equal(isDemoScreen(state), true);
  assert.equal(headerModel(state).status, '◌ demo data');
  assert.match(renderFrame(state, 120, 40).toPlain().split('\n')[0], /◌ demo data/);
  state.live.close();
  feed.close();
});

test('args: --mint validates base58, --interval and --listen parse, --mint refuses fixtures', () => {
  const a = parseArgs(['--screen', 'token', '--mint', BONK, '--interval', '5m', '--listen', '30', '--max-credits', '100']);
  assert.equal(a.mint, BONK);
  assert.equal(a.interval, '5m');
  assert.equal(a.listen, 30);
  assert.equal(a.maxCredits, 100);
  assert.throws(() => parseArgs(['--mint', 'not-a-mint!']), /base58/);
  assert.throws(() => parseArgs(['--interval', '2h']), /unknown interval/);
  assert.throws(() => parseArgs(['--mint', BONK, '--fixtures']), /--mint needs live data/);
  assert.equal(parseArgs(['--listen', '999']).listen, 120, 'clamped to the two-minute session rule');
});

function fakeIo(env: NodeJS.ProcessEnv = {}) {
  let out = '';
  let err = '';
  const stdout = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } }) as unknown as NodeJS.WriteStream & { fd: 1 };
  const stderr = new Writable({ write(chunk, _enc, cb) { err += chunk.toString(); cb(); } }) as unknown as NodeJS.WriteStream & { fd: 2 };
  Object.assign(stdout, { isTTY: false, columns: 120, rows: 40 });
  const stdin = { isTTY: false } as unknown as NodeJS.ReadStream & { fd: 0 };
  return { io: { stdout, stderr, stdin, env }, out: () => out, err: () => err };
}

test('main: --screen newpairs --replay renders the recorded session offline; --screen watchlist --replay renders the empty list', async () => {
  const f = fakeIo({ DEXTERM_OFFLINE: '1' });
  assert.equal(await main(['--screen', 'newpairs', '--replay', T1298, '--width', '120', '--height', '40', '--plain', '--db', ':memory:'], f.io), 0);
  assert.match(f.out(), /New 25/);
  assert.match(f.out(), /replay: pumpportal 25 creates/);
  assert.doesNotMatch(f.out().split('\n')[0], /demo data/);
  assert.ok(!f.out().includes('api-key'));
  const w = fakeIo({ DEXTERM_OFFLINE: '1' });
  assert.equal(await main(['--screen', 'watchlist', '--replay', SAMPLE, '--width', '120', '--height', '40', '--plain', '--db', ':memory:'], w.io), 0);
  assert.match(w.out(), /watchlist is empty/);
  assert.equal(w.err(), '');
  const t = fakeIo({ DEXTERM_OFFLINE: '1' });
  assert.equal(await main(['--screen', 'token', '--mint', BONK, '--replay', T1298, '--width', '176', '--height', '48', '--plain', '--db', ':memory:'], t.io), 0);
  assert.match(t.out(), /via helius/);
  assert.match(t.out(), /9WzD…AWWM/);
  assert.match(t.err(), /not in recording|no recorded fixture/, 'market/candle misses are reported on stderr, not invented');
  assert.match(t.out(), /ANALYST · claude/); // task-1311: on-demand analyst, no "demo" placeholder
  assert.ok(!t.out().includes('api-key') && !t.err().includes('api-key'));
});
