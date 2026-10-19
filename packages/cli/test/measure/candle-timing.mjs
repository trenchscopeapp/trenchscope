// task-1319 item 5: measure the task-1314 candle timeframe switch on the MERGED build (real clock).
// Replays the D06 BONK pool+OHLCV fixture through a transport wrapped with a configurable network
// delay, warms the 1m/1h bases, then times each timeframe switch: the synchronous paint (cached/derived
// from memory) and whether it ever blanked to "loading" (cold). Prints real wall-clock numbers.
//
// Usage: node candle-timing.mjs [delayMs]   (default 300 ms per simulated network request)
import { performance } from 'node:perf_hooks';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixtureStore, replayTransport, createDataLayer } from '../../../data/src/index.ts';
import { TokenLive } from '../../src/live/index.ts';
import { unlimitedBuckets } from '../../src/feed.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(here, '..', '..', '..', 'data', 'fixtures');
const T1298 = resolve(FIX, 'task-1298-sample.json');
const D06 = resolve(FIX, 'd06-sample.json');
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const BONK_POOL = '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9';
const DELAY = Number(process.argv[2] ?? 300);

const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), latencyMs: 3 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tokenTransport() {
  const a = replayTransport(FixtureStore.load(T1298));
  const b = replayTransport(FixtureStore.load(D06));
  const pair = { chainId: 'solana', dexId: 'orca', pairAddress: BONK_POOL, baseToken: { address: BONK, name: 'Bonk', symbol: 'Bonk' }, quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'SOL', symbol: 'SOL' }, priceUsd: '0.0000377', priceNative: '0.00000031', txns: { m5: { buys: 10, sells: 5 }, h1: { buys: 100, sells: 80 }, h6: { buys: 600, sells: 500 }, h24: { buys: 2400, sells: 2000 } }, volume: { m5: 1000, h1: 20000, h6: 150000, h24: 600000 }, priceChange: { m5: 0.1, h1: -1.2, h6: 3.4, h24: -5.6 }, liquidity: { usd: 423751 }, fdv: 3300000, marketCap: 3300000, pairCreatedAt: 1672531200000 };
  const jup = { id: BONK, name: 'Bonk', symbol: 'Bonk', decimals: 5, launchpad: null, holderCount: 1024386, organicScore: 88, isVerified: true, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 36.1, devBalancePercentage: 0.01, devMints: 1 }, usdPrice: 0.0000377, mcap: 3300000, fdv: 3300000, liquidity: 423751, stats24h: { priceChange: -5.6, holderChange: 0.2, numBuys: 2400, numSells: 2000, buyVolume: 300000, sellVolume: 300000 } };
  return async (req) => {
    const u = new URL(req.url);
    if (u.pathname.startsWith('/tokens/v1/solana/')) return json(200, [pair]);
    if (u.pathname === '/tokens/v2/search') return json(200, [jup]);
    if (u.pathname === '/price/v3') return json(200, { [BONK]: { usdPrice: 0.0000377, priceChange24h: -5.6 } });
    // Only the candle (OHLCV) fetch carries the simulated network latency, so the cold-vs-cached
    // candle timing is isolated from the other panels.
    if (u.pathname.includes('/ohlcv/')) { await sleep(DELAY); u.searchParams.delete('token'); return b({ ...req, url: u.toString() }); }
    try { return await a(req); } catch { return b(req); }
  };
}

async function measure() {
  const dl = createDataLayer({ transport: tokenTransport(), dbPath: ':memory:', buckets: unlimitedBuckets() });
  const live = new TokenLive(dl, { mint: BONK, symbol: 'Bonk', name: 'Bonk', launchpad: 'unknown' }, { candleBaseLimit: 100, candleLimit: 100, prefetchCandles: true });

  // COLD first paint: a fresh tab at 1h must fetch the 1h base over the (delayed) network.
  const c0 = performance.now();
  await live.load();
  const coldMs = performance.now() - c0;
  const coldOk = live.view.candles.length > 0;

  // Warm the adjacent bases (prefetch 1m) so derived tabs are in memory.
  await live.prefetchAdjacent?.();
  await sleep(DELAY + 50);

  console.log(`### candle timeframe switch (merged build, real clock, ${DELAY}ms simulated net)`);
  console.log(`- cold first paint (1h base fetched): ${coldMs.toFixed(0)} ms · candles=${live.view.candles.length} · ${coldOk && coldMs < 1500 ? 'PASS <1.5s' : 'CHECK'}`);

  // CACHED/derived switches: 5m,15m (from 1m) · 1m (base) · 4h,1d (from 1h) · 1h (base). All in memory now.
  const order = ['5m', '15m', '1m', '4h', '1d', '1h', '5m', '1d'];
  const rows = [];
  for (const iv of order) {
    const t = performance.now();
    const pr = live.setInterval(iv);
    const syncMs = performance.now() - t;             // synchronous paint cost (the keypress-to-frame cost)
    const blanked = live.view.panels.candles.state === 'loading' && live.view.candles.length === 0;
    await pr;
    const settleMs = performance.now() - t;
    rows.push({ iv, syncMs, blanked, settleMs, n: live.view.candles.length });
  }
  for (const r of rows) {
    console.log(`- → ${r.iv.padEnd(3)}: sync paint ${r.syncMs.toFixed(2)} ms${r.blanked ? ' (BLANKED)' : ''} · settle ${r.settleMs.toFixed(0)} ms · candles=${r.n}`);
  }
  const worstSync = Math.max(...rows.map((r) => r.syncMs));
  const anyBlank = rows.some((r) => r.blanked);
  console.log(`- cached switch: worst sync paint ${worstSync.toFixed(2)} ms · never blanked: ${!anyBlank} · ${worstSync < 300 && !anyBlank ? 'PASS <300ms' : 'CHECK'}`);
  dl.close();
}

measure().catch((e) => { console.error(e); process.exit(1); });
