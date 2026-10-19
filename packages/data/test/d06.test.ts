// D-06: GeckoTerminal OHLCV + closed-bar candle store, Solana RPC (mint authorities,
// top-20 holders), RugCheck summary, MCAP cross-check. Offline: recorded fixtures
// (fixtures/d06-sample.json) plus synthetic responses in the documented shapes.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FakeClock } from '../src/clock.ts';
import { FixtureStore, replayTransport, requestKey } from '../src/fixtures.ts';
import type { HttpRequest, Transport } from '../src/http.ts';
import { HttpError, SourceUnavailableError } from '../src/http.ts';
import { createDataLayer } from '../src/index.ts';
import type { CandleInterval } from '../src/model.ts';
import { CANDLE_INTERVALS, CANDLE_TIMEFRAMES, GeckoTerminal, parseOhlcvList } from '../src/sources/geckoterminal.ts';
import { auditPatchFromRug, normalizeRugSummary } from '../src/sources/rugcheck.ts';
import { auditFromMint, base58, KNOWN_OWNERS, pctOf, rpcBodyCheck, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../src/sources/solana-rpc.ts';
import { MCAP_AGREE_RATIO, resolveMcap } from '../src/store.ts';
import { drive, json, maxInWindow } from './helpers.ts';

const D06_PATH = fileURLToPath(new URL('../fixtures/d06-sample.json', import.meta.url));
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
const PUMP = 'BrUimx7KncgRNTggAdZdaX2s5XUqQyR6XMRmEg4mpump';
const BONK_POOL = '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9';
const RAYDIUM_V4_AUTHORITY = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';

function d06Layer(transport?: Transport) {
  const fixtures = FixtureStore.load(D06_PATH);
  const clock = new FakeClock(Date.parse(fixtures.recordedAt!));
  const replay = replayTransport(fixtures);
  const calls: HttpRequest[] = [];
  const t: Transport = async (req) => {
    calls.push(req);
    return (transport ?? replay)(req);
  };
  const dl = createDataLayer({ clock, transport: t });
  return { dl, clock, fixtures, replay, calls };
}

const rpcMethod = (req: HttpRequest) => (req.body ? (JSON.parse(req.body) as { method: string }).method : null);

// ---------------------------------------------------------------- GeckoTerminal

test('geckoterminal: interval -> timeframe/aggregate URLs match the recorded requests', () => {
  const { fixtures } = d06Layer();
  const recorded = new Set(fixtures.list().map((e) => e.url));
  for (const iv of CANDLE_INTERVALS) {
    const url = GeckoTerminal.ohlcvUrl(BONK_POOL, iv, { limit: 100 });
    assert.ok(recorded.has(new URL(url).toString()), `${iv}: ${url}`);
  }
  assert.deepEqual(CANDLE_INTERVALS, ['1m', '5m', '15m', '1h', '4h', '1d']);
  assert.match(GeckoTerminal.ohlcvUrl(BONK_POOL, '4h', { limit: 5000, token: BONK }), /hour\?aggregate=4&limit=1000&currency=usd&token=Dez/);
});

test('geckoterminal: recorded OHLCV for all six timeframes parses oldest-first on the period grid', async () => {
  const { dl, clock } = d06Layer();
  for (const iv of CANDLE_INTERVALS) {
    const r = await drive(clock, dl.gecko.ohlcv(BONK_POOL, iv, { limit: 100 }));
    const { periodMs } = CANDLE_TIMEFRAMES[iv];
    assert.equal(r.candles.length, 100, iv);
    assert.equal(r.base?.symbol, 'Bonk');
    for (let i = 0; i < r.candles.length; i++) {
      const b = r.candles[i];
      assert.equal(b.t % periodMs, 0, `${iv} bar ${i} off grid`);
      assert.ok(b.l <= Math.min(b.o, b.c) && b.h >= Math.max(b.o, b.c), `${iv} bar ${i} OHLC`);
      assert.ok(b.v >= 0);
      if (i > 0) assert.ok(b.t > r.candles[i - 1].t, `${iv} not strictly ascending`);
    }
  }
});

test('geckoterminal: parseOhlcvList drops malformed rows and duplicate timestamps', () => {
  const bars = parseOhlcvList([[120, 1, 2, 0.5, 1.5, 10], ['x', 1, 1, 1, 1, 1], [60, '1', '1', '1', '1', null], [120, 9, 9, 9, 9, 9], [1, 2]]);
  assert.deepEqual(bars.map((b) => b.t), [60_000, 120_000]);
  assert.equal(bars[0].v, 0);
});

test('geckoterminal: token pools from fixture, most liquid first', async () => {
  const { dl, clock } = d06Layer();
  const pools = await drive(clock, dl.gecko.tokenPools(BONK));
  assert.ok(pools.length > 1);
  assert.equal(pools[0].address, BONK_POOL);
  assert.equal(pools[0].baseMint, BONK);
  for (let i = 1; i < pools.length; i++) assert.ok((pools[i - 1].reserveUsd ?? 0) >= (pools[i].reserveUsd ?? 0));
  const top = await drive(clock, dl.detail.topPool(BONK));
  assert.equal(top?.address, BONK_POOL);
});

test('candle store: recorded 1m series splits into closed bars + open bar and is cached', async () => {
  const { dl, clock, calls } = d06Layer();
  const s = await dl.candles.get(BONK_POOL, '1m', { limit: 100 });
  assert.equal(calls.length, 1);
  assert.equal(s.candles.length, 100);
  const last = s.candles[s.candles.length - 1];
  if (s.openBarT !== null) {
    assert.equal(s.openBarT, last.t);
    assert.ok(last.t + 60_000 > clock.now());
  }
  for (const b of s.candles.slice(0, -1)) assert.ok(b.t + 60_000 <= clock.now());
  const again = await dl.candles.get(BONK_POOL, '1m', { limit: 50 });
  assert.equal(calls.length, 1, 'view TTL hit costs nothing');
  assert.ok(again.fromCache);
  assert.equal(again.candles.length, 50);
});

/** Synthetic GeckoTerminal: `limit` bars ending at the current (open) period, newest first. */
function syntheticGecko(clock: FakeClock, log: { at: number; iv: string; limit: number }[]): Transport {
  return async (req) => {
    const u = new URL(req.url);
    const m = u.pathname.match(/\/ohlcv\/(minute|hour|day)$/);
    if (!m) throw new Error(`unexpected request ${req.url}`);
    const agg = Number(u.searchParams.get('aggregate'));
    const limit = Number(u.searchParams.get('limit'));
    const iv = Object.entries(CANDLE_TIMEFRAMES).find(([, tf]) => tf.timeframe === m[1] && tf.aggregate === agg)![0];
    const periodMs = CANDLE_TIMEFRAMES[iv as CandleInterval].periodMs;
    log.push({ at: clock.now(), iv, limit });
    const open = Math.floor(clock.now() / periodMs) * periodMs;
    const list: number[][] = [];
    for (let i = 0; i < limit; i++) {
      const t = open - i * periodMs;
      const p = 1 + ((t / periodMs) % 7) / 100;
      list.push([t / 1000, p, p * 1.01, p * 0.99, p, 1000 + i]);
    }
    return json(200, { data: { id: 'x', type: 'ohlcv_request_response', attributes: { ohlcv_list: list } }, meta: { base: { address: BONK, symbol: 'Bonk' } } });
  };
}

test('candle soak: all six timeframes stay served within the 10/min budget over 5 fake minutes', async (t) => {
  const clock = new FakeClock(Date.UTC(2026, 9, 6, 2, 0, 7));
  const log: { at: number; iv: string; limit: number }[] = [];
  const dl = createDataLayer({ clock, transport: syntheticGecko(clock, log) });
  const start = clock.now();
  const SOAK_MS = 5 * 60_000;
  const TICK_MS = 2_000;
  const maxAge: Record<string, number> = {};
  const errors: unknown[] = [];

  // Cold start: the detail screen opens with every timeframe requested at once.
  const first = await drive(clock, Promise.all(CANDLE_INTERVALS.map((iv) => dl.candles.get(BONK_POOL, iv))));
  for (const s of first) assert.equal(s.candles.length, 300, s.interval);

  // Then the UI re-reads every timeframe every 2 s (tab flipping / repaint), SWR on.
  while (clock.now() - start < SOAK_MS) {
    const got = await Promise.all(CANDLE_INTERVALS.map((iv) => dl.candles.get(BONK_POOL, iv).catch((e) => (errors.push(e), null))));
    for (const s of got) {
      if (!s) continue;
      maxAge[s.interval] = Math.max(maxAge[s.interval] ?? 0, clock.now() - s.fetchedAt);
      const { periodMs } = CANDLE_TIMEFRAMES[s.interval];
      assert.equal(s.candles.length, 300);
      for (let i = 1; i < s.candles.length; i++) assert.equal(s.candles[i].t - s.candles[i - 1].t, periodMs, `${s.interval} gap/dup at ${i}`);
    }
    await clock.advance(TICK_MS);
  }
  await drive(clock, Promise.resolve());

  assert.deepEqual(errors, []);
  const budget = Math.floor(10 * 0.7);
  assert.ok(maxInWindow(log.map((r) => r.at), 60_000) <= budget, `max ${maxInWindow(log.map((r) => r.at), 60_000)} requests in a minute (budget ${budget})`);
  // Closed-bar caching: exactly one full-depth fetch per timeframe, the rest are tail refreshes.
  for (const iv of CANDLE_INTERVALS) {
    const mine = log.filter((r) => r.iv === iv);
    assert.equal(mine.filter((r) => r.limit === 300).length, 1, `${iv}: ${mine.map((r) => r.limit).join(',')}`);
    assert.ok(mine.length >= 3, `${iv} refreshed only ${mine.length} times`);
    for (const r of mine.slice(1)) assert.ok(r.limit <= 5, `${iv} tail refresh asked for ${r.limit} bars`);
    // Every timeframe is refreshed at least every ~2 minutes despite 12/min of demand.
    assert.ok(maxAge[iv] <= 120_000, `${iv} served data aged ${maxAge[iv]} ms`);
  }
  assert.ok(log.length <= budget * 5 + 1, `${log.length} requests in 5 min`);
  t.diagnostic(`soak: ${log.length} requests, max ${maxInWindow(log.map((r) => r.at), 60_000)}/min (budget ${budget}), max served age ${JSON.stringify(maxAge)}`);
  dl.close();
});

// ---------------------------------------------------------------- Solana RPC: mints

test('rpc mint decode: BONK (SPL, authorities revoked)', async () => {
  const { dl } = d06Layer();
  const info = await dl.rpc.mintInfo(BONK);
  assert.equal(info.program, 'spl-token');
  assert.equal(info.programId, TOKEN_PROGRAM);
  assert.equal(info.mintAuthority, null);
  assert.equal(info.freezeAuthority, null);
  assert.equal(info.decimals, 5);
  assert.ok(info.isInitialized);
  assert.ok(BigInt(info.supply) > 10n ** 18n, 'u64 supply kept exact as a string');
  assert.deepEqual(info.extensions, []);
  const audit = auditFromMint(info);
  assert.equal(audit.mintAuthority, false);
  assert.equal(audit.freezeAuthority, false);
  assert.deepEqual(audit.rugRisks, []);
});

test('rpc mint decode: PYUSD (Token-2022) matches the RPC jsonParsed view of the same account', async () => {
  const { dl, fixtures } = d06Layer();
  const info = await dl.rpc.mintInfo(PYUSD);
  const parsedEntry = fixtures.list().find((e) => e.method === 'POST' && JSON.stringify(e.requestBody).includes('jsonParsed'))!;
  const parsed = (parsedEntry.body as { result: { value: { owner: string; data: { parsed: { info: Record<string, unknown> & { extensions: { extension: string }[] } } } } } }).result.value;
  const p = parsed.data.parsed.info;
  assert.equal(info.program, 'token-2022');
  assert.equal(info.programId, TOKEN_2022_PROGRAM);
  assert.equal(parsed.owner, TOKEN_2022_PROGRAM);
  assert.equal(info.mintAuthority, p.mintAuthority);
  assert.equal(info.freezeAuthority, p.freezeAuthority);
  assert.equal(info.supply, p.supply);
  assert.equal(info.decimals, p.decimals);
  assert.deepEqual(info.extensions, p.extensions.map((e) => e.extension));
  assert.deepEqual(info.riskyExtensions.sort(), ['mintCloseAuthority', 'permanentDelegate', 'transferFeeConfig', 'transferHook']);
  const audit = auditFromMint(info);
  assert.equal(audit.mintAuthority, true);
  assert.equal(audit.freezeAuthority, true);
  assert.ok(audit.rugRisks.includes('token-2022:permanentDelegate'));
});

test('rpc mint decode: pump.fun launch (Token-2022, authorities revoked)', async () => {
  const { dl } = d06Layer();
  const info = await dl.rpc.mintInfo(PUMP);
  assert.equal(info.mintAuthority, null);
  assert.equal(info.freezeAuthority, null);
  assert.equal(info.decimals, 6);
  assert.equal(info.programId, TOKEN_2022_PROGRAM);
});

test('rpc: only allow-listed read methods are ever sent', async () => {
  const { dl, calls } = d06Layer();
  const call = (dl.rpc as unknown as { call: (m: string, p: unknown[]) => Promise<unknown> }).call.bind(dl.rpc);
  await assert.rejects(call('sendTransaction', ['AAAA']), /refusing non-read RPC method/);
  await assert.rejects(call('requestAirdrop', [BONK, 1]), /refusing non-read RPC method/);
  assert.equal(calls.length, 0);
});

test('fixtures: POST entries match on the canonical JSON-RPC body', () => {
  const { fixtures } = d06Layer();
  const url = 'https://api.mainnet-beta.solana.com/';
  const body = { jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [BONK, { encoding: 'base64', commitment: 'confirmed' }] };
  assert.ok(fixtures.find({ method: 'POST', url, body: JSON.stringify(body, null, 2) }));
  assert.equal(fixtures.find({ method: 'POST', url, body: JSON.stringify({ ...body, params: [PYUSD + 'x', body.params[1]] }) }), undefined);
  assert.notEqual(requestKey({ method: 'POST', url, body: '{"a":1}' }), requestKey({ method: 'POST', url, body: '{"a":2}' }));
});

// ---------------------------------------------------------------- Solana RPC: top-20 holders

function b58decode(s: string): Uint8Array {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(A.indexOf(ch));
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

/** Deterministic distinct 32-byte key for index i. */
function key(i: number, salt: number): Uint8Array {
  const b = new Uint8Array(32);
  for (let j = 0; j < 32; j++) b[j] = (i * 31 + j * 7 + salt * 13 + 1) & 0xff;
  return b;
}

/** SPL token account bytes (165): mint, owner, amount (u64 LE), rest zero. */
function tokenAccount(mint: Uint8Array, owner: Uint8Array, amount: bigint): string {
  const buf = Buffer.alloc(165);
  buf.set(mint, 0);
  buf.set(owner, 32);
  buf.writeBigUInt64LE(amount, 64);
  return buf.toString('base64');
}

/**
 * The public RPC answered getTokenLargestAccounts with 429 on every recording attempt
 * (fixtures keep two of them), so the top-20 path uses responses built in the documented
 * shapes: getTokenLargestAccounts -> { value: [{ address, amount, decimals, uiAmount }] },
 * getMultipleAccounts(base64) -> { value: [{ data: [b64, 'base64'], owner, ... }] }.
 * The mint itself (supply, decimals) replays from the recorded PUMP account.
 */
function holdersTransport(replay: Transport, opts: { ownersStatus?: number } = {}) {
  const mintBytes = b58decode(PUMP);
  const accounts = Array.from({ length: 20 }, (_, i) => ({
    address: base58(key(i, 1)),
    owner: i === 0 ? b58decode(RAYDIUM_V4_AUTHORITY) : key(i, 2),
    // Largest first; 18-digit raw amounts so a double would lose precision.
    amount: 123_456_789_012_345_678n / BigInt(i + 1) / 1000n,
  }));
  const t: Transport = async (req) => {
    const method = rpcMethod(req);
    if (method === 'getTokenLargestAccounts') {
      return json(200, { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: accounts.map((a) => ({ address: a.address, amount: a.amount.toString(), decimals: 6, uiAmount: Number(a.amount) / 1e6, uiAmountString: '' })) } });
    }
    if (method === 'getMultipleAccounts') {
      if (opts.ownersStatus) return json(opts.ownersStatus, { error: 'boom' });
      const asked = (JSON.parse(req.body!) as { params: [string[]] }).params[0];
      const value = asked.map((addr) => {
        const a = accounts.find((x) => x.address === addr);
        return a ? { data: [tokenAccount(mintBytes, a.owner, a.amount), 'base64'], owner: TOKEN_2022_PROGRAM, lamports: 2039280, executable: false } : null;
      });
      return json(200, { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value } });
    }
    return replay(req);
  };
  return { t, accounts };
}

test('rpc top-20 holders: owners decoded from token accounts, bigint shares, LP excluded from top 10', async () => {
  const fixtures = FixtureStore.load(D06_PATH);
  const { t, accounts } = holdersTransport(replayTransport(fixtures));
  const { dl, clock, calls } = d06Layer(t);
  const info = await drive(clock, dl.rpc.mintInfo(PUMP));
  const h = await drive(clock, dl.rpc.topHolders(PUMP, { info }));
  assert.deepEqual(calls.map(rpcMethod), ['getAccountInfo', 'getTokenLargestAccounts', 'getMultipleAccounts']);
  assert.equal(h.holders.length, 20);
  const supply = BigInt(info.supply);
  h.holders.forEach((x, i) => {
    assert.equal(x.tokenAccount, accounts[i].address);
    assert.equal(x.owner, base58(accounts[i].owner));
    assert.equal(x.address, x.owner);
    assert.equal(x.pct, pctOf(accounts[i].amount, supply));
    assert.equal(x.amount, Number(accounts[i].amount) / 1e6);
  });
  assert.equal(h.holders[0].owner, RAYDIUM_V4_AUTHORITY, 'base58 round-trips a known address');
  assert.equal(h.holders[0].label, KNOWN_OWNERS[RAYDIUM_V4_AUTHORITY]);
  assert.equal(h.holders[0].label, 'LP');
  const expectedTop10 = h.holders.slice(1, 11).reduce((s, x) => s + x.pct, 0);
  assert.ok(Math.abs(h.top10Pct! - expectedTop10) < 0.001, `${h.top10Pct} vs ${expectedTop10}`);
  assert.equal(h.decimals, 6);
  assert.equal(h.supply, info.supply);
});

test('rpc top-20 holders: owner lookup failing keeps token accounts and shares', async () => {
  const fixtures = FixtureStore.load(D06_PATH);
  const { t, accounts } = holdersTransport(replayTransport(fixtures), { ownersStatus: 500 });
  const { dl, clock } = d06Layer(t);
  const h = await drive(clock, dl.rpc.topHolders(PUMP));
  assert.equal(h.holders.length, 20);
  for (const [i, x] of h.holders.entries()) {
    assert.equal(x.owner, null);
    assert.equal(x.address, accounts[i].address);
    assert.equal(x.label, undefined);
  }
});

test('token detail: holders reuse the cached mint info and cache for 60 s', async () => {
  const fixtures = FixtureStore.load(D06_PATH);
  const { t } = holdersTransport(replayTransport(fixtures));
  const { dl, clock, calls } = d06Layer(t);
  const a = await drive(clock, dl.detail.holders(PUMP));
  assert.equal(a.value.holders.length, 20);
  assert.equal(calls.length, 3);
  await clock.advance(30_000);
  await dl.detail.holders(PUMP);
  await dl.detail.mintInfo(PUMP);
  assert.equal(calls.length, 3, 'holders (60 s) and mint (10 min) served from cache');
  await clock.advance(31_000);
  const c = await dl.detail.holders(PUMP);
  await drive(clock, c.refreshing!);
  assert.deepEqual(calls.slice(3).map(rpcMethod), ['getTokenLargestAccounts', 'getMultipleAccounts'], 'refresh skips getAccountInfo');
});

test('rpc: the recorded public-RPC 429 on getTokenLargestAccounts surfaces as HttpError 429', async () => {
  const { dl } = d06Layer();
  await assert.rejects(dl.rpc.largestAccounts(BONK), (e: unknown) => e instanceof HttpError && e.status === 429);
});

// ---------------------------------------------------------------- health / backoff

test('health: repeated recorded RPC 429s demote solana-rpc, honor Retry-After, back off, then recover', async () => {
  let overrideOk = false;
  const fixtures = FixtureStore.load(D06_PATH);
  const replay = replayTransport(fixtures);
  const { dl, clock, calls } = d06Layer(async (req) =>
    overrideOk ? json(200, { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: [] } }) : replay(req),
  );
  await assert.rejects(dl.rpc.largestAccounts(BONK), /429/);
  assert.equal(dl.health.state('solana-rpc'), 'ok', 'one 429 is not enough');
  const paused1 = dl.limiter.bucket('solana-rpc').stats().pausedUntil - clock.now();
  assert.equal(paused1, 10_000, 'Retry-After: 10');

  // Second call waits out the Retry-After pause, then 429s again -> degraded.
  await drive(clock, assert.rejects(dl.rpc.largestAccounts(BONK), /429/));
  assert.equal(dl.health.state('solana-rpc'), 'degraded');
  assert.equal(calls.length, 2);
  const paused2 = dl.limiter.bucket('solana-rpc').stats().pausedUntil - clock.now();
  assert.ok(paused2 >= 59_000, `consecutive 429 doubles the pause (got ${paused2} ms)`);

  // While degraded, nothing goes out.
  await assert.rejects(dl.rpc.largestAccounts(BONK), SourceUnavailableError);
  assert.equal(calls.length, 2);

  // After the 30 s demotion window the source probes; one success restores it.
  await clock.advance(30_000);
  assert.equal(dl.health.state('solana-rpc'), 'probing');
  overrideOk = true;
  await drive(clock, dl.rpc.largestAccounts(BONK));
  assert.equal(dl.health.state('solana-rpc'), 'ok');
  assert.equal(calls.length, 3);
});

test('health: JSON-RPC rate-limit errors delivered with HTTP 200 count as 429s', async () => {
  assert.deepEqual(rpcBodyCheck({ jsonrpc: '2.0', error: { code: 429, message: 'Too many requests for a specific RPC call' } }), { status: 429, error: 'rpc error 429: Too many requests for a specific RPC call' });
  assert.deepEqual(rpcBodyCheck({ error: { code: -32602, message: 'Invalid param' } }), { error: 'rpc error -32602: Invalid param' });
  assert.equal(rpcBodyCheck({ result: {} }), null);

  const clock = new FakeClock(Date.UTC(2026, 9, 6));
  let n = 0;
  const dl = createDataLayer({
    clock,
    transport: async () => (n++, json(200, { jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'Too many requests' } })),
  });
  await assert.rejects(dl.rpc.mintInfo(BONK), /Too many requests/);
  await drive(clock, assert.rejects(dl.rpc.mintInfo(BONK), /Too many requests/));
  assert.equal(n, 2);
  assert.equal(dl.health.state('solana-rpc'), 'degraded');
  dl.close();
});

test('health: GeckoTerminal 429s demote the source; candles fall back to the cached series', async () => {
  const clock = new FakeClock(Date.UTC(2026, 9, 6, 2, 0, 7));
  const log: { at: number; iv: string; limit: number }[] = [];
  const good = syntheticGecko(clock, log);
  let limited = false;
  const dl = createDataLayer({ clock, transport: async (req) => (limited ? json(429, { status: '429', title: 'Rate Limited' }) : good(req)) });
  const s = await drive(clock, dl.candles.get(BONK_POOL, '5m', { swr: false }));
  assert.equal(s.candles.length, 300);
  limited = true;
  await clock.advance(31_000);
  const a = await drive(clock, dl.candles.get(BONK_POOL, '5m', { swr: false }));
  assert.ok(a.stale && a.error instanceof HttpError && a.error.status === 429);
  assert.equal(a.candles.length, 300, 'cached series still served');
  // No Retry-After: default 30 s pause, doubled on the next consecutive 429.
  const p1 = dl.limiter.bucket('geckoterminal').stats().pausedUntil - clock.now();
  assert.ok(p1 > 29_000 && p1 <= 30_000, `${p1}`);
  const b = await drive(clock, dl.candles.get(BONK_POOL, '5m', { swr: false }));
  assert.ok(b.stale && b.error);
  assert.equal(dl.health.state('geckoterminal'), 'degraded');
  const c = await dl.candles.get(BONK_POOL, '5m', { swr: false });
  assert.ok(c.error instanceof SourceUnavailableError, 'degraded source is not called');
  assert.equal(c.candles.length, 300);
  dl.close();
});

// ---------------------------------------------------------------- RugCheck

test('rugcheck summary: recorded pump.fun launch normalizes', async () => {
  const { dl } = d06Layer();
  const r = await dl.detail.rugcheck(PUMP);
  assert.equal(r.value.mint, PUMP);
  assert.equal(r.value.tokenProgram, TOKEN_2022_PROGRAM);
  assert.equal(r.value.tokenType, null, 'empty string -> null');
  assert.equal(r.value.score, 1);
  assert.equal(r.value.scoreNormalised, 1);
  assert.ok(r.value.lpLockedPct! > 99);
  assert.deepEqual(r.value.risks, []);
  assert.deepEqual(auditPatchFromRug(r.value), { lpLockedPct: r.value.lpLockedPct, rugRisks: [], rugScore: 1 });
});

test('rugcheck summary: risks sorted danger-first, junk dropped, null risks tolerated', () => {
  const s = normalizeRugSummary(
    PUMP,
    {
      score: 5001,
      score_normalised: 72,
      risks: [
        { name: 'Low Liquidity', level: 'warn', score: 400, value: '$1.2K' },
        { name: 'Mutable metadata', level: 'info', score: 100, description: '' },
        { name: '', level: 'danger', score: 9999 },
        { name: 'Freeze Authority still enabled', level: 'danger', score: 7500, description: 'Tokens can be frozen' },
        { name: 'Top 10 holders high ownership', level: 'weird', score: 10 },
      ],
    },
    1,
  );
  assert.deepEqual(s.risks.map((r) => [r.name, r.level]), [
    ['Freeze Authority still enabled', 'danger'],
    ['Low Liquidity', 'warn'],
    ['Mutable metadata', 'info'],
    ['Top 10 holders high ownership', 'unknown'],
  ]);
  assert.equal(s.risks[2].description, null);
  assert.equal(auditPatchFromRug(s).rugScore, 72);
  assert.deepEqual(normalizeRugSummary(PUMP, { risks: null }, 1).risks, []);
});

// ---------------------------------------------------------------- MCAP rule

test('mcap: larger of DexScreener/Jupiter when within 5x, else DexScreener flagged', () => {
  assert.equal(MCAP_AGREE_RATIO, 5);
  assert.deepEqual(resolveMcap({ mcap: 1_000_000, fdv: 2_000_000 }, 4_000_000), { value: 4_000_000, basis: 'jupiter', flagged: false, dexscreener: 1_000_000, jupiter: 4_000_000 });
  assert.equal(resolveMcap({ mcap: 3_000_000, fdv: null }, 1_000_000).basis, 'dexscreener');
  assert.equal(resolveMcap({ mcap: 1_000_000, fdv: null }, 5_000_000).flagged, false, 'exactly 5x agrees');
  const far = resolveMcap({ mcap: 1_000_000, fdv: null }, 50_000_000);
  assert.deepEqual([far.value, far.basis, far.flagged], [1_000_000, 'dexscreener', true]);
  assert.equal(resolveMcap({ mcap: null, fdv: 2_000_000 }, null).value, 2_000_000, 'fdv fallback');
  assert.deepEqual([resolveMcap(undefined, 7).value, resolveMcap(undefined, 7).basis], [7, 'jupiter']);
  assert.equal(resolveMcap({ mcap: 0, fdv: null }, NaN).value, null);
});
