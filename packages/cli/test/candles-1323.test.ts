// task-1323 item 2: the cold-candle delay. Live evidence (test/measure/boot-candles-1323.md): opening a
// token on 1h and pressing 5m sent the 1m base fetch ~17 s later — FIFO in the GeckoTerminal bucket
// (burst 1, one slot per ~8.6 s) behind the 1h candles and the trades tape. These pin the fix with a
// fake transport + fake clock: request ORDER and COUNT for open → cold switch, and the hover prefetch's
// debounce / idle-only / soft-cap behaviour (a fast scroll can never queue Gecko work).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDataLayer, FakeClock, DEFAULT_BUCKETS, type Transport, type HttpResponse } from '@dexterm/data';
import { TokenLive } from '../src/live/index.ts';
import { CandlePrefetcher } from '../src/live/token.ts';

const POOL = 'POOLaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MINT = 'MINTbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function ohlcv(periodS: number, n: number, nowMs: number): string {
  const end = Math.floor(nowMs / 1000 / periodS) * periodS;
  const list = Array.from({ length: n }, (_, i) => { const t = end - i * periodS; return [t, 1 + i * 0.001, 1.1, 0.9, 1, 100]; });
  return JSON.stringify({ data: { attributes: { ohlcv_list: list } } });
}

/** Gecko answers OHLCV/trades; every other source 404s (those panels fail; irrelevant here). */
function fakeNet(clock: { now(): number }, log: { at: number; path: string }[], delayMs: Partial<Record<string, number>> = {}): Transport {
  return async (req) => {
    const u = new URL(req.url);
    const res = (status: number, body: string): HttpResponse => ({ status, headers: { 'content-type': 'application/json' }, body, latencyMs: 1 });
    if (u.host !== 'api.geckoterminal.com') return res(404, '{}');
    const kind = u.pathname.includes('/ohlcv/minute') ? 'ohlcv/minute' : u.pathname.includes('/ohlcv/hour') ? 'ohlcv/hour' : u.pathname.includes('/ohlcv/day') ? 'ohlcv/day' : u.pathname.endsWith('/trades') ? 'trades' : u.pathname;
    log.push({ at: clock.now(), path: kind });
    const delay = delayMs[kind] ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (kind === 'ohlcv/minute') return res(200, ohlcv(60, 300, clock.now()));
    if (kind === 'ohlcv/hour') return res(200, ohlcv(3600, 300, clock.now()));
    if (kind === 'trades') return res(200, JSON.stringify({ data: [] }));
    return res(404, '{}');
  };
}

const settle = async (clock: FakeClock, ms = 0) => { for (let i = 0; i < 5; i++) await clock.advance(i === 0 ? ms : 0); };

test('open on 1h, press 5m: the 1m base goes out AT the keypress, ahead of the trades tape; 3 Gecko calls total', async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const log: { at: number; path: string }[] = [];
  const dl = createDataLayer({ transport: fakeNet(clock, log), clock, disabled: ['pumpfun'], rpcFallbackUrl: null });
  const t0 = clock.now();
  const live = new TokenLive(dl, { mint: MINT, symbol: 'TST', name: 'Test', launchpad: 'pump.fun', pair: POOL }, { interval: '1h', candleLimit: 120, now: () => clock.now() });
  void live.load();
  await settle(clock);
  assert.deepEqual(log.map((l) => l.path), ['ohlcv/hour'], 'the open fetches the viewed base first');
  assert.ok(live.view.candles.length > 0, '1h chart painted');

  await settle(clock, 2_000); // the user reads for 2 s, then presses 5m
  const pressAt = clock.now();
  void live.setInterval('5m');
  await settle(clock);
  assert.deepEqual(log.map((l) => l.path), ['ohlcv/hour', 'ohlcv/minute'], 'the cold base was sent before the queued trades tape');
  assert.equal(log[1].at, pressAt, 'granted at the keypress: no rate-limit wait (pre-1323: ~17 s)');
  assert.equal(live.view.interval, '5m');
  assert.ok(live.view.candles.length > 0 && live.view.panels.candles.state === 'ok', '5m painted, derived from the 1m base');

  // Low-priority tape: needs 2 tokens again (reserve kept) → ~17.1 s after the open. Stay inside the
  // 30 s candle view TTL so the tab sweep below is pure memory (a later sweep would revalidate the open bar).
  await settle(clock, 20_000);
  const paths = log.map((l) => l.path);
  assert.deepEqual(paths, ['ohlcv/hour', 'ohlcv/minute', 'trades'], 'the tape follows within budget; prefetch re-fetches neither base');
  assert.ok(log[2].at - t0 >= 8_000, 'the tape waited for a reserve-safe slot (background priority)');
  // Every other tab now paints from memory, no request.
  for (const iv of ['1m', '15m', '1h', '4h', '1d'] as const) { void live.setInterval(iv); assert.ok(live.view.candles.length > 0, `${iv} instant`); }
  await settle(clock);
  assert.equal(log.filter((l) => l.path.startsWith('ohlcv')).length, 2, 'six tabs, two base fetches');
  dl.close();
});

test('hover prefetch: a fast scroll sends nothing; resting sends ONE idle request; nothing ever queues', async () => {
  const log: { at: number; path: string }[] = [];
  const dl = createDataLayer({ transport: fakeNet({ now: () => Date.now() }, log), disabled: ['pumpfun'], rpcFallbackUrl: null });
  const pf = new CandlePrefetcher(dl, { interval: () => '1h', debounceMs: 40 });
  const bucket = dl.limiter.bucket('geckoterminal');
  let maxQueued = 0;
  for (let i = 0; i < 40; i++) {
    pf.hover({ mint: `${MINT.slice(0, -2)}${String(i).padStart(2, '0')}`, pair: `${POOL.slice(0, -2)}${String(i).padStart(2, '0')}` });
    maxQueued = Math.max(maxQueued, bucket.stats().queued);
    await new Promise((r) => setTimeout(r, 8)); // 8 ms per row: faster than the debounce
  }
  assert.equal(log.length, 0, 'scrolling past rows sends nothing');
  await pf.settled(); // rest on the last row; wait for both sequential base attempts
  assert.deepEqual(log.map((l) => l.path), ['ohlcv/hour'], 'the rested row gets its default base');
  assert.ok(pf.deferred >= 1, 'the second base was deferred: the bucket is no longer idle (reserve kept)');
  assert.equal(bucket.stats().queued, 0, 'a deferred idle request leaves nothing queued');
  assert.equal(maxQueued, 0);
  assert.ok(dl.detail.candleStore.has(`${POOL.slice(0, -2)}39`, '1h', { limit: 1000, token: `${MINT.slice(0, -2)}39` }), 'cached for the open');
  pf.close();
  dl.close();
});

test('hover prefetch: soft cap per minute, cached bases skipped, close() stops pending work', async () => {
  const log: { at: number; path: string }[] = [];
  // Unlimited Gecko bucket so only the prefetcher's own soft cap can hold it back.
  const buckets = { ...DEFAULT_BUCKETS, geckoterminal: { rpm: 1e6, burst: 1e6, reserve: 1 } };
  // Reproduce the hosted macOS failure deterministically: the second request cannot start before this
  // first sequential request finishes, which is later than the removed fixed 60 ms sleep.
  const dl = createDataLayer({ transport: fakeNet({ now: () => Date.now() }, log, { 'ohlcv/minute': 80 }), buckets, disabled: ['pumpfun'], rpcFallbackUrl: null });
  const pf = new CandlePrefetcher(dl, { interval: () => '5m', debounceMs: 5, maxPerMin: 3 });
  const rest = async (i: number) => { pf.hover({ mint: `m${i}`, pair: `p${i}` }); await pf.settled(); };
  await rest(0);
  assert.deepEqual(log.map((l) => l.path), ['ohlcv/minute', 'ohlcv/hour'], '5m → its 1m base first, then the other base');
  await rest(0);
  assert.equal(log.length, 2, 'cached bases are not re-fetched');
  await rest(1);
  await rest(2);
  assert.equal(pf.requests, 3, 'capped at 3 sent per rolling minute');
  assert.equal(pf.rate(), 3);
  pf.hover({ mint: 'm9', pair: 'p9' });
  const pending = pf.settled();
  pf.close();
  await pending;
  assert.equal(pf.requests, 3, 'close() cancelled the pending debounce');
  dl.close();
});
