// Shrine on the live TOKEN screen: with a key the chart is served by mint from Shrine's 1 s rows (no pool
// needed), the panel and caption name the source, coarser tabs derive from the same base, and a Shrine
// outage leaves GeckoTerminal serving exactly as before. Offline: a scripted fake socket, fetch blocked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cache, FakeClock, createDataLayer, base58Decode, PUMP_AMM_PROGRAM, type DataLayer, type HttpRequest, type HttpResponse, type WsLike } from '@dexterm/data';
import { Canvas, THEMES } from '@dexterm/tui';
import { makeFixtureState } from '../src/state.ts';
import { TokenLive, type TokenView } from '../src/live/token.ts';
import { renderTokenLive } from '../src/live/screens/token-live.ts';
import type { LiveContext } from '../src/live/index.ts';
import { unlimitedBuckets } from '../src/feed.ts';

globalThis.fetch = (async (input: unknown) => { throw new Error(`network access blocked in tests: ${String(input)}`); }) as typeof fetch;

const NOW = 1_792_358_910_000;
const KEY = 'shr_test_0123456789abcdef';
const MINT = 'SEn1BLFPXv4rGTWUus6DkjowGpK5wsNPv3Nps1Rpump';
const POOL = '2JKFP1Ut7P4B46RaTnVfKuywC4SjJEMXuX5P4ZfFWhbo';
/** A legacy PumpSwap pool for MINT (no virtual reserves): a venue Shrine is allowed to serve. */
function legacyPool(): Buffer {
  const data = Buffer.alloc(301);
  const WSOL = 'So11111111111111111111111111111111111111112';
  for (const [k, at] of [[MINT, 43], [WSOL, 75], [MINT, 139], [WSOL, 171]] as const) Buffer.from(base58Decode(k)).copy(data, at);
  return data;
}
const WSOL = 'So11111111111111111111111111111111111111112';

const json = (status: number, body: unknown): HttpResponse => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), latencyMs: 2 });

/** A socket.io server that answers history with `rows` one-minute rows and pushes the SOL snapshot on subscribe. */
function fakeShrine(rows: number, accept = KEY) {
  const sockets: { closed: boolean }[] = [];
  const seen = { histories: 0 };
  const factory = (): WsLike => {
    const listeners = new Map<string, (ev: { data?: unknown }) => void>();
    const push = (data: string) => listeners.get('message')?.({ data });
    const ws = {
      readyState: 1, closed: false,
      addEventListener: (type: string, fn: (ev: { data?: unknown }) => void) => { listeners.set(type, fn); },
      close() { ws.closed = true; },
      send(text: string) {
        if (text.startsWith('40')) { queueMicrotask(() => push(JSON.parse(text.slice(2)).api_key === accept ? '40{"sid":"s"}' : '44{"message":"no"}')); return; }
        const m = /^42(\d+)(\[.*\])$/s.exec(text);
        if (!m) return;
        const [event] = JSON.parse(m[2]) as [string];
        if (event === 'ohlcv_history') seen.histories++;
        queueMicrotask(() => {
          if (event === 'subscribe') push(`42${JSON.stringify(['token_update', { pool: POOL, price: 3e-8, priceUSD: 3e-8 * 100, quote: WSOL, time: NOW / 1000 }])}`);
          const ack = event === 'ohlcv_history'
            ? { ok: true, pool: POOL, data: Array.from({ length: rows }, (_, i) => [NOW - (rows - i) * 60_000, 3e-8, 3.1e-8, 2.9e-8, 3e-8, 1]) }
            : { ok: true };
          push(`43${m[1]}${JSON.stringify([ack])}`);
        });
      },
    };
    sockets.push(ws);
    queueMicrotask(() => push('0{"pingInterval":25000,"pingTimeout":20000}'));
    return ws;
  };
  return { factory, sockets, seen };
}

/** Everything HTTP fails except the chain read (a non-PumpSwap pool), the SOL price and GeckoTerminal ohlcv. */
function transport(calls: string[]) {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req.url);
    if (req.url.includes('/price/v3')) return json(200, { [WSOL]: { usdPrice: 100 } });
    if (req.url.includes('geckoterminal.com') && req.url.includes('/ohlcv/')) {
      return json(200, { data: { attributes: { ohlcv_list: Array.from({ length: 60 }, (_, i) => [Math.floor(NOW / 60_000 - i - 1) * 60, 2, 2, 2, 2, 1]) } }, meta: {} });
    }
    if (req.method === 'POST' && req.body?.includes('getMultipleAccounts')) {
      const addresses = (JSON.parse(req.body) as { params: [string[]] }).params[0];
      return json(200, { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: addresses.map((a) => (a === POOL ? { data: [legacyPool().toString('base64'), 'base64'], owner: PUMP_AMM_PROGRAM, lamports: 1 } : null)) } });
    }
    return json(404, {});
  };
}

async function open(dl: DataLayer, clock: FakeClock, pair: string | null): Promise<TokenLive> {
  const live = new TokenLive(dl, { mint: MINT, symbol: 'FOMO', name: 'FomoFamily', launchpad: 'pump.fun', ...(pair ? { pair } : {}) }, { interval: '1m', candleLimit: 120, candleBaseLimit: 1000, prefetchCandles: false, now: () => clock.now() });
  const p = live.load();
  for (let i = 0; i < 50 && live.view.updatedAt === null; i++) await clock.advance(100);
  await p;
  return live;
}

function caption(v: TokenView): string {
  const cache = new Cache({ path: ':memory:' });
  const dl = { cache } as unknown as DataLayer;
  const ctx = { dl, intel: null, token: { dl, view: v }, rpc: { provider: 'helius', basis: 'test' }, fastLane: null, badgeFor: () => 'POLL', livePrice: () => null, watch: { has: () => false }, creditsStatus: () => undefined } as unknown as LiveContext;
  const state = makeFixtureState({ screen: 'token', theme: THEMES.midnight, calm: true });
  state.screener.source = 'live';
  state.live = ctx;
  state.now = new Date(NOW);
  const c = new Canvas(176, 48, THEMES.midnight);
  c.fill(0, 0, 176, 48, ' ', { bg: THEMES.midnight.bg });
  renderTokenLive(c, state, v);
  cache.close();
  return c.toPlain();
}

test('token screen: with a Shrine key the chart comes from Shrine by mint, even with no pair, and says so', async () => {
  const clock = new FakeClock(NOW);
  const calls: string[] = [];
  const shrine = fakeShrine(90);
  const dl = createDataLayer({ clock, transport: transport(calls), buckets: unlimitedBuckets(), shrineKey: KEY, shrineSocket: { ws: shrine.factory }, rpcFallbackUrl: null });
  const live = await open(dl, clock, null);
  const v = live.view;
  assert.equal(v.panels.candles.state, 'ok');
  assert.equal(v.panels.candles.via, 'shrine');
  assert.equal(v.candles.length, 90);
  assert.ok(Math.abs(v.candles.at(-1)!.c - 3e-8 * 100) < 1e-15, 'USD at the SOL rate');
  assert.equal(v.panels.trades.state, 'error', 'the tape still needs a pool');
  assert.match(caption(v), /ohlcv: shrine/);
  // a coarser tab derives from the same Shrine base: no new history request within the TTL
  assert.equal(shrine.seen.histories, 1);
  await live.setInterval('5m');
  assert.equal(live.view.panels.candles.via, 'shrine');
  assert.ok(live.view.candles.length >= 18 && live.view.candles.length <= 19);
  assert.equal(shrine.seen.histories, 1);
  dl.close();
  assert.equal(dl.shrine!.client.state, 'closed');
  assert.equal(dl.shrine!.client.pendingTimers, 0);
});

test('token screen: a refused Shrine key leaves GeckoTerminal serving the chart, as without a key', async () => {
  const clock = new FakeClock(NOW);
  const calls: string[] = [];
  const shrine = fakeShrine(90, 'someone_elses_key_1');
  const dl = createDataLayer({ clock, transport: transport(calls), buckets: unlimitedBuckets(), shrineKey: KEY, shrineSocket: { ws: shrine.factory }, rpcFallbackUrl: null });
  const live = await open(dl, clock, '7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm');
  assert.equal(live.view.panels.candles.via, 'geckoterminal');
  assert.ok(live.view.candles.length > 0);
  assert.match(caption(live.view), /ohlcv: geckoterminal/);
  dl.close();
});
