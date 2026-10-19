// Shrine (keyed 1 s candles over socket.io): framing, key handling, host pin, history validation, the
// bad-print filter, bucketing, the PumpSwap virtual-reserve repricing, the GeckoTerminal fallback and a
// clean shutdown. Offline: a scripted fake WebSocket stands in for the server; helpers.ts blocks fetch.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeClock } from '../src/clock.ts';
import type { HttpRequest } from '../src/http.ts';
import { createDataLayer } from '../src/index.ts';
import { base58 } from '../src/sources/solana-rpc.ts';
import { base58Decode, PUMP_PROGRAM_ID, pumpBondingCurve } from '../src/sources/pda.ts';
import type { WsLike } from '../src/sources/pumpportal.ts';
import { SHRINE_WS_URL, SHRINE_HOST, ShrineSocket, type ShrineTimers } from '../src/sources/shrine-socket.ts';
import {
  Shrine, boostedPrice, bucketShrineRows, readShrineVenue, validateShrineRows, isShrineAddress,
  PUMP_AMM_PROGRAM, SHRINE_MAX_MOVE, type AccountsReader,
} from '../src/sources/shrine.ts';
import { resolveShrineKey } from '../src/shrine-config.ts';
import { json } from './helpers.ts';

const KEY = 'shr_test_0123456789abcdef';
const WSOL = 'So11111111111111111111111111111111111111112';
// FOMO on 2026-10-18 (tape test/shrine-boost-pool.test.ts): a PumpSwap pool with 17.58 SOL of virtual quote reserves.
const MINT = 'SEn1BLFPXv4rGTWUus6DkjowGpK5wsNPv3Nps1Rpump';
const POOL = '2JKFP1Ut7P4B46RaTnVfKuywC4SjJEMXuX5P4ZfFWhbo';
const BASE_VAULT = '6NvUAJyJfkZnvwYuWfgUVLyfd3P38uur68MZCpHBgnnM';
const QUOTE_VAULT = 'GS219oa6wHCApF2bAai1WT36xisNthA6cWiuX5ZDFS4Y';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const BOOST = { virtualQuote: 17.582_593_611, quoteReserve: 0.355_605_376, baseReserve: 992_928_830.050871 };
const NOW = 1_792_358_910_000;

// ---------------------------------------------------------------------------------------------------------
// A scripted socket.io server behind a fake WebSocket.

type Reply = (event: string, data: unknown) => unknown;
class FakeServer {
  sockets: FakeWs[] = [];
  urls: string[] = [];
  /** ack payload per event; undefined = never ack (timeout tests) */
  reply: Reply = () => ({ ok: true });
  /** events pushed before the ack of a request (subscribe snapshot) */
  before: (event: string, data: unknown) => [string, unknown][] = () => [];
  acceptKey = KEY;
  handshake = true;
  factory = (url: string): WsLike => {
    this.urls.push(url);
    const ws = new FakeWs(this);
    this.sockets.push(ws);
    if (this.handshake) queueMicrotask(() => ws.push('0{"sid":"e1","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}'));
    return ws;
  };
  get last(): FakeWs { return this.sockets[this.sockets.length - 1]; }
}
class FakeWs implements WsLike {
  readyState = 1;
  sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, ((ev: { data?: unknown; code?: number }) => void)[]>();
  private readonly server: FakeServer;
  constructor(server: FakeServer) { this.server = server; }
  addEventListener(type: string, fn: (ev: { data?: unknown; code?: number }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  push(text: string): void { for (const fn of this.listeners.get('message') ?? []) fn({ data: text }); }
  drop(): void { this.closed = true; for (const fn of this.listeners.get('close') ?? []) fn({ code: 1006 }); }
  close(): void { this.closed = true; this.readyState = 3; }
  send(text: string): void {
    this.sent.push(text);
    if (text.startsWith('40')) {
      const auth = JSON.parse(text.slice(2)) as { api_key?: string };
      queueMicrotask(() => this.push(auth.api_key === this.server.acceptKey ? '40{"sid":"s1"}' : '44{"message":"invalid api key shr_server_echo"}'));
      return;
    }
    const m = /^42(\d+)(\[.*\])$/s.exec(text);
    if (!m) return;
    const [event, data] = JSON.parse(m[2]) as [string, unknown];
    queueMicrotask(() => {
      for (const [e, d] of this.server.before(event, data)) this.push(`42${JSON.stringify([e, d])}`);
      const ack = this.server.reply(event, data);
      if (ack !== undefined) this.push(`43${m[1]}${JSON.stringify([ack])}`);
    });
  }
}

/** Manual timers: tests fire them explicitly and can assert none is left behind. */
class ManualTimers implements ShrineTimers {
  private seq = 0;
  readonly live = new Map<number, { fn: () => void; ms: number }>();
  set(fn: () => void, ms: number): unknown { const id = ++this.seq; this.live.set(id, { fn, ms }); return id; }
  clear(h: unknown): void { this.live.delete(h as number); }
  /** Fire every pending timer whose delay is `ms` (or all when omitted). */
  fire(ms?: number): number {
    let n = 0;
    for (const [id, t] of [...this.live]) if (ms === undefined || t.ms === ms) { this.live.delete(id); t.fn(); n++; }
    return n;
  }
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };

// ---------------------------------------------------------------------------------------------------------
// socket.io / Engine.IO framing

test('socket: handshake, auth packet, acked request, ping/pong, server events and server-requested acks', async () => {
  const server = new FakeServer();
  server.reply = (event, data) => (event === 'ohlcv_history' ? { ok: true, pool: POOL, data: [], echo: data } : { ok: true });
  const timers = new ManualTimers();
  const s = new ShrineSocket({ apiKey: KEY, ws: server.factory, timers });
  const ack = await s.request('ohlcv_history', { mint: MINT, limit: 500 }) as { ok: boolean; pool: string; echo: unknown };
  assert.equal(ack.pool, POOL);
  assert.deepEqual(ack.echo, { mint: MINT, limit: 500 });
  const ws = server.last;
  assert.equal(ws.sent[0], `40${JSON.stringify({ api_key: KEY })}`, 'joins the default namespace with the key as auth');
  assert.equal(ws.sent[1], `420${JSON.stringify(['ohlcv_history', { mint: MINT, limit: 500 }])}`, 'event with ack id 0');
  assert.equal(s.state, 'open');
  // ping -> pong
  ws.push('2');
  assert.equal(ws.sent.at(-1), '3');
  // server event, plain and namespaced, and one that asks for an ack
  const seen: unknown[] = [];
  s.on('token_update', (d) => seen.push(d));
  ws.push(`42${JSON.stringify(['token_update', { pool: POOL, n: 1 }])}`);
  ws.push(`42/,${JSON.stringify(['token_update', { pool: POOL, n: 2 }])}`);
  ws.push(`427${JSON.stringify(['token_update', { pool: POOL, n: 3 }])}`);
  assert.deepEqual(seen.map((x) => (x as { n: number }).n), [1, 2, 3]);
  assert.equal(ws.sent.at(-1), '437[]', 'acks a server event that carries an id');
  // garbage frames are ignored, not thrown
  for (const junk of ['', '4', '42', '42{not json', '43', '439[1]', '5', '6', 'x']) ws.push(junk);
  // a second request gets the next ack id; an unrelated ack id resolves nothing
  assert.deepEqual(await s.request('subscribe', { pool: POOL }), { ok: true });
  assert.ok(ws.sent.some((f) => f.startsWith('421["subscribe"')), 'the next request carries ack id 1');
  s.close();
});

test('socket: the key travels only in the CONNECT auth packet, never in the URL; the host is pinned to wss', async () => {
  const server = new FakeServer();
  const s = new ShrineSocket({ apiKey: KEY, ws: server.factory, timers: new ManualTimers(), ...({ url: 'wss://evil.example/socket.io/' } as object) });
  await s.request('ohlcv_history', { mint: MINT, limit: 500 });
  assert.deepEqual(server.urls, [SHRINE_WS_URL], 'an unknown url option is ignored: the host is fixed');
  assert.equal(SHRINE_WS_URL, 'wss://sol.shrine.trade/socket.io/?EIO=4&transport=websocket');
  assert.equal(new URL(SHRINE_WS_URL).host, SHRINE_HOST);
  assert.equal(new URL(SHRINE_WS_URL).protocol, 'wss:');
  for (const url of server.urls) assert.ok(!url.includes(KEY), 'no key in the URL');
  const carrying = server.last.sent.filter((f) => f.includes(KEY));
  assert.deepEqual(carrying, [`40${JSON.stringify({ api_key: KEY })}`], 'exactly one frame carries the key: the auth packet');
  s.close();
});

test('socket: a refused key rejects with a fixed phrase (no key, no server text) and does not retry while unheld', async () => {
  const server = new FakeServer();
  server.acceptKey = 'some_other_key_123';
  const health: [boolean, string | undefined][] = [];
  const timers = new ManualTimers();
  const s = new ShrineSocket({ apiKey: KEY, ws: server.factory, timers, onHealth: (ok, e) => health.push([ok, e]) });
  await assert.rejects(s.request('ohlcv_history', { mint: MINT }), (err: Error) => {
    assert.equal(err.name, 'ShrineError');
    assert.ok(!err.message.includes(KEY) && !err.message.includes('shr_server_echo'), err.message);
    return true;
  });
  assert.equal(health.length, 1);
  assert.equal(health[0][0], false);
  assert.ok(!String(health[0][1]).includes(KEY));
  assert.equal(server.sockets.length, 1);
  assert.equal(server.last.closed, true);
  assert.equal(s.pendingTimers, 0, 'no retry or idle timer after a refusal');
  s.close();
});

test('socket: bounded ack, connect and ping timeouts', async () => {
  const server = new FakeServer();
  server.reply = () => undefined; // never ack
  const timers = new ManualTimers();
  const s = new ShrineSocket({ apiKey: KEY, ws: server.factory, timers, ackTimeoutMs: 1234, connectTimeoutMs: 999 });
  const p = s.request('ohlcv_history', { mint: MINT });
  await flush();
  assert.equal(timers.fire(1234), 1, 'the ack timer is armed with ackTimeoutMs');
  await assert.rejects(p, /timed out/);
  // ping watchdog: pingInterval + pingTimeout from the handshake
  assert.ok([...timers.live.values()].some((t) => t.ms === 45_000));
  timers.fire(45_000);
  assert.equal(server.last.closed, true, 'a silent server is dropped');
  assert.equal(s.state, 'idle');
  // connect timeout: a server that never completes the handshake
  server.handshake = false;
  const q = s.request('ohlcv_history', { mint: MINT });
  await flush();
  assert.equal(timers.fire(999), 1);
  await assert.rejects(q, /connect timed out/);
  s.close();
  assert.equal(s.pendingTimers, 0);
});

test('socket: idle close when nobody holds it; held sockets reconnect with backoff and replay onConnect', async () => {
  const server = new FakeServer();
  const timers = new ManualTimers();
  const s = new ShrineSocket({ apiKey: KEY, ws: server.factory, timers, idleCloseMs: 15_000, baseBackoffMs: 1000, maxBackoffMs: 4000 });
  await s.request('ohlcv_history', { mint: MINT });
  assert.ok([...timers.live.values()].some((t) => t.ms === 15_000), 'idle close armed after the last request');
  timers.fire(15_000);
  assert.equal(server.last.closed, true);
  assert.equal(s.state, 'idle');
  // A held socket: connects, and after a drop reconnects with doubling backoff, replaying the hooks.
  let connects = 0;
  s.onConnect(() => { connects++; });
  const release = s.hold();
  await flush();
  assert.equal(s.state, 'open');
  assert.equal(connects, 1);
  server.last.drop();
  assert.equal(s.state, 'idle');
  assert.ok([...timers.live.values()].some((t) => t.ms === 1000), 'first retry after the base backoff');
  timers.fire(1000);
  await flush();
  assert.equal(s.state, 'open');
  assert.equal(connects, 2, 'subscriptions are replayed on reconnect');
  assert.equal(server.sockets.length, 3);
  release();
  assert.ok([...timers.live.values()].some((t) => t.ms === 15_000), 'released: idle close armed again');
  s.close();
  assert.equal(s.pendingTimers, 0);
});

test('socket: close() and the shutdown signal reject pending work and leave no timer or socket', async () => {
  const server = new FakeServer();
  server.reply = () => undefined;
  const timers = new ManualTimers();
  const shutdown = new AbortController();
  const s = new ShrineSocket({ apiKey: KEY, ws: server.factory, timers, shutdownSignal: shutdown.signal });
  const release = s.hold();
  const p = s.request('ohlcv_history', { mint: MINT });
  await flush();
  assert.ok(timers.live.size > 0);
  shutdown.abort();
  await assert.rejects(p, /closed/);
  assert.equal(s.state, 'closed');
  assert.equal(server.last.closed, true);
  assert.equal(timers.live.size, 0, 'every timer cleared');
  assert.equal(s.pendingTimers, 0);
  release();
  assert.equal(timers.live.size, 0, 'a late release does not arm anything');
  await assert.rejects(s.request('ohlcv_history', { mint: MINT }), /closed/);
  assert.equal(server.sockets.length, 1, 'a closed client never reconnects');
});

test('socket: real timers are unref\'d so an idle client never holds the event loop', async () => {
  const server = new FakeServer();
  const made: ReturnType<typeof setTimeout>[] = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => { const t = real(fn, ms); made.push(t); return t; }) as typeof setTimeout;
  try {
    const s = new ShrineSocket({ apiKey: KEY, ws: server.factory });
    await s.request('ohlcv_history', { mint: MINT });
    assert.ok(made.length >= 3, 'connect, ping and ack timers at least');
    for (const t of made) assert.equal(t.hasRef(), false);
    s.close();
    assert.equal(s.pendingTimers, 0);
  } finally {
    globalThis.setTimeout = real;
  }
});

// ---------------------------------------------------------------------------------------------------------
// history validation, bad prints, bucketing

test('validateShrineRows: drops malformed, out-of-window and impossible rows; clamps wicks; dedupes seconds', () => {
  const t = NOW - 60_000;
  const { rows, dropped } = validateShrineRows([
    [t, 1, 1.2, 0.9, 1.1, 5],
    [t + 1000, 1.1, 1.1, 1.1, 1.1, 0],
    [t + 1500, 1, 1, 1, 1, 1], // not a whole second
    [t + 2000, 1, 0.5, 0.9, 1, 1], // high below the body
    [t + 3000, 1, 1, 1, 1, -1], // negative volume
    [t + 4000, 1, 1, 1, 1], // short tuple
    'x',
    [t + 5000, 0, 1, 1, 1, 1], // zero open
    [NOW + 60_000, 1, 1, 1, 1, 1], // future
    [NOW - 31 * 86_400_000, 1, 1, 1, 1, 1], // older than 30 days
    [t + 6000, 1, 1, 1, 200, 1], // body spans 200x: bad print
    [t + 7000, 1.2, 2.5e6, 1.1, 1.3, 2], // wick 2e6x: clamped to the body
    [t + 7000, 1.2, 1.4, 1.1, 1.3, 3], // same second again: last wins
  ], NOW);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.t), [t, t + 1000, t + 7000]);
  assert.deepEqual(rows[2], { t: t + 7000, o: 1.2, h: 1.4, l: 1.1, c: 1.3, v: 3 });
  assert.equal(dropped, 10);
  const clamp = validateShrineRows([[t, 1.2, 2.5e6, 1e-9, 1.3, 2]], NOW).rows[0];
  assert.equal(clamp.h, 1.3, 'a wick past MAX_MOVE is clamped to the body top');
  assert.equal(clamp.l, 1.2, 'and the low to the body bottom');
  assert.throws(() => validateShrineRows({ not: 'an array' }, NOW), /invalid history/);
});

test('validateShrineRows: a bad print inside one second goes, a rug across seconds is real and stays', () => {
  const t = NOW - 600_000;
  // tape 7RcM...pump: a first-second print opening at 4e-8 and closing 2.5e6x higher
  const { rows, dropped } = validateShrineRows([[t, 4e-8, 0.1, 4e-8, 0.1, 1], [t + 1000, 4e-8, 4.1e-8, 4e-8, 4.1e-8, 1]], NOW);
  assert.deepEqual(rows.map((r) => r.c), [4.1e-8]);
  assert.equal(dropped, 1);
  // FOMO's dump, 2026-10-18: the vault price fell 4000x in 19 s. Every second of it is kept.
  const rug = [1.4297e-5, 3.2807e-9, 5.2118e-10, 3.7924955576379334e-10].map((p, i) => [t + i * 19_000, p, p, p, p, 1]);
  assert.equal(validateShrineRows(rug, NOW).rows.length, 4);
  assert.equal(SHRINE_MAX_MOVE, 100);
});

test('bucketShrineRows: aligned buckets, previous-close opens, summed volume, gaps stay gaps', () => {
  const m = 60_000;
  const base = 1_792_000_000_000 - (1_792_000_000_000 % m);
  const rows = [
    { t: base + 1000, o: 1, h: 1.5, l: 0.9, c: 1.2, v: 1 },
    { t: base + 59_000, o: 1.2, h: 1.3, l: 1.1, c: 1.25, v: 2 },
    { t: base + m + 5000, o: 1.4, h: 1.6, l: 1.35, c: 1.5, v: 3 },
    { t: base + 3 * m, o: 0.9, h: 1.0, l: 0.8, c: 0.95, v: 4 },
  ];
  const bars = bucketShrineRows([...rows].reverse(), m);
  assert.deepEqual(bars, [
    { t: base, o: 1, h: 1.5, l: 0.9, c: 1.25, v: 3 },
    { t: base + m, o: 1.25, h: 1.6, l: 1.25, c: 1.5, v: 3 },
    { t: base + 3 * m, o: 1.5, h: 1.5, l: 0.8, c: 0.95, v: 4 },
  ]);
  assert.throws(() => bucketShrineRows(rows, 0), /Invalid candle interval/);
});

test('isShrineAddress: 32-byte keys only', () => {
  assert.equal(isShrineAddress(MINT), true);
  assert.equal(isShrineAddress(WSOL), true);
  assert.equal(isShrineAddress('1111'), false);
  assert.equal(isShrineAddress('0OIl' + 'x'.repeat(40)), false);
  assert.equal(isShrineAddress(42), false);
});

// ---------------------------------------------------------------------------------------------------------
// PumpSwap virtual-reserve repricing

function poolBytes(opts: { base?: string; quote?: string; virtual?: bigint } = {}): Buffer {
  const data = Buffer.alloc(301);
  for (const [k, at] of [[opts.base ?? MINT, 43], [opts.quote ?? WSOL, 75], [BASE_VAULT, 139], [QUOTE_VAULT, 171]] as const) Buffer.from(base58Decode(k)).copy(data, at);
  data.writeBigUInt64LE(opts.virtual ?? 17_582_593_611n, 245);
  return data;
}
function mintBytes(): Buffer { const d = Buffer.alloc(82); d.writeBigUInt64LE(995_213_227_997_339n, 36); d[44] = 6; d[45] = 1; return d; }
function tokenAccount(amount: bigint): Buffer { const d = Buffer.alloc(165); d.writeBigUInt64LE(amount, 64); return d; }
const acct = (owner: string, data: Buffer) => ({ owner, data: data.toString('base64') });
function reader(map: Record<string, { owner: string; data: string } | null>, calls: string[][] = []): AccountsReader {
  return async (addresses) => { calls.push(addresses); return new Map(addresses.map((a) => [a, map[a] ?? null])); };
}
const FOMO_ACCOUNTS = {
  [POOL]: acct(PUMP_AMM_PROGRAM, poolBytes()),
  [MINT]: acct(TOKEN22, mintBytes()),
  [BASE_VAULT]: acct(TOKEN22, tokenAccount(992_928_830_050_871n)),
  [QUOTE_VAULT]: acct(TOKEN, tokenAccount(355_605_376n)),
};

test('boostedPrice: FOMO charts the vault price 50x low; the repriced value matches its chain fills', () => {
  // tape: history closes and what those seconds filled at on chain (Helius parsed swaps)
  const cases: [number, number][] = [[1.4297e-5, 1.48e-5], [3.2807e-9, 2.35e-8], [5.2118e-10, 1.83e-8], [3.571413615800093e-10, 0.000970244 / 53_697.738905]];
  for (const [raw, fill] of cases) assert.ok(Math.abs(boostedPrice(raw, BOOST) / fill - 1) < 0.1, `${raw} -> ${boostedPrice(raw, BOOST)} vs ${fill}`);
  assert.ok(boostedPrice(3.57e-10, BOOST) / 3.57e-10 > 45, 'the uncorrected price is ~50x low');
  assert.ok(Math.abs(boostedPrice(3.5e-10, { ...BOOST, virtualQuote: 0 }) - 3.5e-10) < 1e-20, 'no virtual reserves: unchanged');
});

test('readShrineVenue: verifies owners and vaults from one snapshot; refuses what it cannot price', async () => {
  const calls: string[][] = [];
  const v = await readShrineVenue(reader(FOMO_ACCOUNTS, calls), MINT, POOL);
  assert.equal(v.venue, 'pumpswap');
  assert.equal(v.quoteMint, WSOL);
  assert.ok(v.boost);
  assert.ok(Math.abs(v.boost!.virtualQuote - BOOST.virtualQuote) < 1e-9);
  assert.ok(Math.abs(v.boost!.quoteReserve - BOOST.quoteReserve) < 1e-9);
  assert.ok(Math.abs(v.boost!.baseReserve - BOOST.baseReserve) < 1e-6);
  assert.deepEqual(calls, [[POOL, MINT], [BASE_VAULT, QUOTE_VAULT, POOL]], 'vaults and pool read together');
  // legacy pool without virtual reserves: one read, no correction
  assert.deepEqual(await readShrineVenue(reader({ ...FOMO_ACCOUNTS, [POOL]: acct(PUMP_AMM_PROGRAM, poolBytes({ virtual: 0n })) }), MINT, POOL), { venue: 'pumpswap', quoteMint: WSOL, boost: null });
  // the mint's own bonding curve: no correction; a curve account that is not this mint's curve is refused
  const CURVE = pumpBondingCurve(MINT);
  assert.equal((await readShrineVenue(reader({ [CURVE]: acct(PUMP_PROGRAM_ID, Buffer.alloc(150)) }), MINT, CURVE)).venue, 'pump-curve');
  await assert.rejects(readShrineVenue(reader({ [POOL]: acct(PUMP_PROGRAM_ID, Buffer.alloc(150)) }), MINT, POOL), /curve does not match mint/);
  // any other program is not verified here, so it is refused (the chart falls back to GeckoTerminal)
  await assert.rejects(readShrineVenue(reader({ [POOL]: acct('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', Buffer.alloc(752)) }), MINT, POOL), /unverified pool venue/);
  // bytes that only look like a PumpSwap pool are not trusted without the owner
  await assert.rejects(readShrineVenue(reader({ ...FOMO_ACCOUNTS, [POOL]: acct('Fake111111111111111111111111111111111111111', poolBytes()) }), MINT, POOL), /unverified pool venue/);
  await assert.rejects(readShrineVenue(reader({}), MINT, POOL), /pool account not found/);
  await assert.rejects(readShrineVenue(reader({ ...FOMO_ACCOUNTS, [POOL]: acct(PUMP_AMM_PROGRAM, poolBytes({ base: WSOL, quote: WSOL })) }), MINT, POOL), /does not hold this mint/);
  await assert.rejects(readShrineVenue(reader({ ...FOMO_ACCOUNTS, [BASE_VAULT]: acct('Fake111111111111111111111111111111111111111', tokenAccount(1n)) }), MINT, POOL), /vaults not readable/);
  await assert.rejects(readShrineVenue(reader({ ...FOMO_ACCOUNTS, [MINT]: null }), MINT, POOL), /mint account/);
  const usdcQuoted = poolBytes({ quote: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' });
  await assert.rejects(readShrineVenue(reader({ ...FOMO_ACCOUNTS, [POOL]: acct(PUMP_AMM_PROGRAM, usdcQuoted) }), MINT, POOL), /not priceable/);
});

// ---------------------------------------------------------------------------------------------------------
// adapter end to end over the fake socket

function fomoServer(rowsAt = NOW): FakeServer {
  const server = new FakeServer();
  const closes = [1.4297e-5, 3.2807e-9, 5.2118e-10, 3.7924955576379334e-10, 3.571413615800093e-10];
  server.reply = (event) => {
    if (event === 'ohlcv_history') return { ok: true, pool: POOL, data: closes.map((p, i) => [rowsAt - (closes.length - i) * 60_000, p, p, p, p, 0.5]) };
    if (event === 'subscribe') return { ok: true, room: `pool:${POOL}`, pool: POOL };
    return { ok: true };
  };
  server.before = (event) => (event === 'subscribe' ? [['token_update', { pool: POOL, price: 3.6e-10, priceUSD: 3.6e-10 * 103.7, quote: WSOL, time: Math.floor(rowsAt / 1000) }]] : []);
  return server;
}

test('Shrine.history: USD rows, repriced through the chain read, at a fresh SOL/USD; unsubscribes after the snapshot', async () => {
  const server = fomoServer();
  const clock = new FakeClock(NOW);
  const shrine = new Shrine({ apiKey: KEY, accounts: reader(FOMO_ACCOUNTS), solUsd: async () => 104, clock, socket: { ws: server.factory, timers: new ManualTimers() } });
  const h = await shrine.history(MINT);
  assert.equal(h.pool, POOL);
  assert.equal(h.venue, 'pumpswap');
  assert.equal(h.adjusted, 'pumpswap-virtual-reserves');
  assert.equal(h.quoteMint, WSOL);
  assert.equal(h.quoteUsd, 104);
  assert.equal(h.quoteSource, 'jupiter-price');
  assert.equal(h.rows.length, 5);
  assert.equal(h.capped, false);
  const last = h.rows.at(-1)!;
  assert.ok(Math.abs(last.c / (boostedPrice(3.571413615800093e-10, BOOST) * 104) - 1) < 1e-9);
  assert.ok(Math.abs(last.v - 0.5 * 104) < 1e-9, 'volume is quote volume times the quote rate');
  // the repriced last close agrees with what that second filled at on chain (tape: 1.807e-8 SOL) within 10%
  assert.ok(Math.abs(last.c / 104 / (0.000970244 / 53_697.738905) - 1) < 0.1);
  const frames = server.last.sent.map((f) => f.replace(/^42\d*/, ''));
  assert.ok(frames.some((f) => f.startsWith('["subscribe"')));
  assert.ok(frames.some((f) => f === JSON.stringify(['unsubscribe', { pool: POOL }])), 'the snapshot subscription is released');
  shrine.close();
  assert.equal(shrine.client.pendingTimers, 0);
});

test('Shrine.history: Shrine\'s own SOL ratio only near the last good Jupiter price; unsupported quotes and empty history throw', async () => {
  const clock = new FakeClock(NOW);
  // a legacy PumpSwap pool (no virtual reserves): a verified venue, no repricing
  const other = { ...FOMO_ACCOUNTS, [POOL]: acct(PUMP_AMM_PROGRAM, poolBytes({ virtual: 0n })) };
  // Jupiter never answered: Shrine's ratio alone is not trusted
  const cold = fomoServer();
  const s0 = new Shrine({ apiKey: KEY, accounts: reader(other), solUsd: async () => { throw new Error('jupiter down'); }, clock, socket: { ws: cold.factory, timers: new ManualTimers() } });
  await assert.rejects(s0.history(MINT), /no SOL\/USD rate/);
  s0.close();
  // Jupiter answered once (104), then went down: Shrine's 103.7 is within 20 %, so it serves
  const server = fomoServer();
  let jupCalls = 0;
  const shrine = new Shrine({ apiKey: KEY, accounts: reader(other), solUsd: async () => { if (jupCalls++ === 0) return 104; throw new Error('jupiter down'); }, clock, socket: { ws: server.factory, timers: new ManualTimers() } });
  assert.equal((await shrine.history(MINT)).quoteSource, 'jupiter-price');
  const h = await shrine.history(MINT);
  assert.equal(h.quoteSource, 'shrine');
  assert.ok(Math.abs(h.quoteUsd - 103.7) < 1e-9);
  assert.equal(h.adjusted, null, 'no virtual reserves: no repricing');
  shrine.close();

  const odd = fomoServer();
  odd.before = () => [['token_update', { pool: POOL, price: 1, priceUSD: 7, quote: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', time: NOW / 1000 }]];
  const s2 = new Shrine({ apiKey: KEY, accounts: reader(other), solUsd: async () => 104, clock, socket: { ws: odd.factory, timers: new ManualTimers() } });
  await assert.rejects(s2.history(MINT), /quote token disagrees with chain/);
  s2.close();

  const empty = fomoServer();
  empty.reply = (event) => (event === 'ohlcv_history' ? { ok: true, pool: POOL, data: [] } : { ok: true });
  const s3 = new Shrine({ apiKey: KEY, accounts: reader(other), clock, socket: { ws: empty.factory, timers: new ManualTimers() } });
  await assert.rejects(s3.history(MINT), /no history/);
  await assert.rejects(s3.history('not-a-mint'), /invalid mint/);
  s3.close();

  const bad = fomoServer();
  bad.reply = (event) => (event === 'ohlcv_history' ? { ok: true, pool: 'nope', data: [] } : { ok: false });
  const s4 = new Shrine({ apiKey: KEY, accounts: reader(other), clock, socket: { ws: bad.factory, timers: new ManualTimers() } });
  await assert.rejects(s4.history(MINT), /invalid pool/);
  s4.close();
});

// ---------------------------------------------------------------------------------------------------------
// data layer: Shrine first, GeckoTerminal fallback, clean shutdown

const GECKO_POOL = '7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm';
function geckoRows(n: number, stepSec = 60, at = NOW): number[][] {
  return Array.from({ length: n }, (_, i) => [Math.floor(at / 1000 / stepSec - (n - i)) * stepSec, 2, 2, 2, 2, 10]);
}
function layer(server: FakeServer, opts: { geckoBars?: number; geckoFails?: boolean; rpcOwner?: string } = {}) {
  const calls: string[] = [];
  const transport = async (req: HttpRequest) => {
    calls.push(req.url);
    if (req.url.includes('geckoterminal.com') && req.url.includes('/ohlcv/')) {
      if (opts.geckoFails) return json(500, { error: 'down' });
      const step = req.url.includes('/ohlcv/hour') ? 3600 : req.url.includes('/ohlcv/day') ? 86_400 : 60;
      return json(200, { data: { attributes: { ohlcv_list: geckoRows(opts.geckoBars ?? 50, step).reverse() } }, meta: {} });
    }
    if (req.url.includes('/price/v3')) return json(200, { [WSOL]: { usdPrice: 104 } });
    if (req.method === 'POST') {
      const body = JSON.parse(req.body ?? '{}') as { params: [string[]] };
      // default: a legacy PumpSwap pool for MINT (a verified venue); rpcOwner overrides the owner
      const value = body.params[0].map((a) => (a === POOL ? { data: [poolBytes({ virtual: 0n }).toString('base64'), 'base64'], owner: opts.rpcOwner ?? PUMP_AMM_PROGRAM, lamports: 1, executable: false } : null));
      return json(200, { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value } });
    }
    return json(404, {});
  };
  const clock = new FakeClock(NOW);
  const dl = createDataLayer({ clock, transport, shrineKey: KEY, shrineSocket: { ws: server.factory, timers: new ManualTimers() }, rpcFallbackUrl: null });
  return { dl, calls };
}

/** A minute-dense Shrine window: `n` one-minute rows ending at NOW. */
function denseServer(n: number, endAt = NOW): FakeServer {
  const server = fomoServer();
  server.reply = (event) => (event === 'ohlcv_history' ? { ok: true, pool: POOL, data: Array.from({ length: n }, (_, i) => [endAt - (n - i) * 60_000, 3e-8, 3e-8, 3e-8, 3e-8, 1]) } : { ok: true });
  return server;
}

test('TokenDetail.candles: Shrine serves first and says so; health, budget and bucket record it', async () => {
  const server = denseServer(200);
  const { dl, calls } = layer(server);
  // the screen's pair is the pool Shrine charts
  const s = await dl.detail.candles(POOL, '1m', { limit: 1000, token: MINT });
  assert.equal(s.source, 'shrine');
  assert.equal(s.pool, POOL);
  assert.equal(s.candles.length, 200);
  assert.ok(Math.abs(s.candles.at(-1)!.c - 3e-8 * 104) < 1e-15);
  assert.equal(s.basis?.quoteSource, 'jupiter-price');
  assert.ok(!calls.some((u) => u.includes('geckoterminal')), 'GeckoTerminal not asked');
  assert.equal(dl.health.get('shrine').state, 'ok');
  assert.ok(dl.health.get('shrine').okCount >= 2);
  assert.ok(dl.budget.status('shrine').session >= 2);
  // the cached history serves the next interval without another socket request
  const sent = server.last.sent.length;
  const fives = await dl.detail.candles(POOL, '5m', { limit: 1000, token: MINT });
  assert.equal(fives.source, 'shrine');
  assert.ok(fives.candles.length >= 40 && fives.candles.length <= 41, 'five-minute buckets of 200 one-minute rows');
  assert.equal(server.last.sent.length, sent);
  dl.close();
});

test('TokenDetail.candles: any Shrine failure falls back to GeckoTerminal; a thin window loses to a deeper one', async () => {
  // refused key -> GeckoTerminal
  const refused = denseServer(40);
  refused.acceptKey = 'not_our_key_12345';
  const a = layer(refused);
  const s = await a.dl.detail.candles(GECKO_POOL, '1m', { limit: 1000, token: MINT });
  assert.equal(s.source, 'geckoterminal');
  assert.equal(s.candles.length, 50);
  a.dl.close();
  // a PumpSwap pool whose vaults cannot be read -> never charted uncorrected -> GeckoTerminal
  const pumpswap = denseServer(40);
  const b = layer(pumpswap, { rpcOwner: PUMP_AMM_PROGRAM });
  assert.equal((await b.dl.detail.candles(GECKO_POOL, '1m', { limit: 1000, token: MINT })).source, 'geckoterminal');
  b.dl.close();
  // Shrine charting a side pool (not the screen's pair) loses to a deeper GeckoTerminal main pool...
  const side = layer(denseServer(40));
  assert.equal((await side.dl.detail.candles(GECKO_POOL, '1m', { limit: 1000, token: MINT })).source, 'geckoterminal');
  side.dl.close();
  // ...and wins when it has more bars than GeckoTerminal
  const sideDeep = layer(denseServer(80));
  assert.equal((await sideDeep.dl.detail.candles(GECKO_POOL, '1m', { limit: 1000, token: MINT })).source, 'shrine');
  sideDeep.dl.close();
  // a side pool quiet for over an hour is never charted, even as the last resort...
  const stale = layer(denseServer(80, NOW - 2 * 3_600_000), { geckoFails: true });
  await assert.rejects(stale.dl.detail.candles(GECKO_POOL, '1m', { limit: 1000, token: MINT }), /HTTP 500|500/);
  // ...while the screen's own pool may be quiet: its last print is the market
  assert.equal((await stale.dl.detail.candles(POOL, '1m', { limit: 1000, token: MINT })).source, 'shrine');
  stale.dl.close();
  // thin Shrine window (3 one-hour bars) vs 50 GeckoTerminal bars -> GeckoTerminal
  const thin = denseServer(150);
  const c = layer(thin);
  assert.equal((await c.dl.detail.candles(GECKO_POOL, '1h', { limit: 1000, token: MINT })).source, 'geckoterminal');
  // ...but when GeckoTerminal fails (or has fewer), the thin Shrine window is still real data
  c.dl.close();
  const d = layer(denseServer(150), { geckoFails: true });
  const thinOnly = await d.dl.detail.candles(GECKO_POOL, '1h', { limit: 1000, token: MINT });
  assert.equal(thinOnly.source, 'shrine');
  assert.ok(thinOnly.candles.length >= 2 && thinOnly.candles.length <= 4);
  d.dl.close();
  // no pool at all: Shrine alone; Shrine failing too surfaces Shrine's error
  const e = layer(denseServer(5));
  assert.equal((await e.dl.detail.candles('', '1m', { limit: 1000, token: MINT })).source, 'shrine');
  e.dl.close();
  const dead = denseServer(5);
  dead.reply = (event) => (event === 'ohlcv_history' ? { ok: false } : { ok: true });
  const f = layer(dead);
  await assert.rejects(f.dl.detail.candles('', '1m', { limit: 1000, token: MINT }), /shrine: history unavailable/);
  f.dl.close();
});

test('TokenDetail.candles: without a key or a mint, GeckoTerminal only (unchanged behaviour)', async () => {
  const server = denseServer(40);
  const calls: string[] = [];
  const dl = createDataLayer({
    clock: new FakeClock(NOW), shrineKey: null,
    transport: async (req) => { calls.push(req.url); return json(200, { data: { attributes: { ohlcv_list: geckoRows(10) } }, meta: {} }); },
  });
  assert.equal(dl.shrine, null);
  assert.equal(dl.detail.hasShrine, false);
  assert.equal(dl.health.get('shrine').state, 'needs-key');
  assert.equal((await dl.detail.candles(GECKO_POOL, '1m', { limit: 100, token: MINT })).source, 'geckoterminal');
  dl.close();
  const { dl: keyed } = layer(server);
  assert.equal((await keyed.detail.candles(GECKO_POOL, '1m', { limit: 100 })).source, 'geckoterminal', 'no mint: no Shrine');
  assert.equal(server.sockets.length, 0, 'the socket is lazy');
  keyed.close();
});

test('data layer close(): the Shrine socket closes and no timer is left behind', async () => {
  const server = denseServer(40);
  const { dl } = layer(server);
  await dl.detail.candles(GECKO_POOL, '1m', { limit: 1000, token: MINT });
  assert.equal(dl.shrine!.client.state, 'open');
  dl.close();
  assert.equal(dl.shrine!.client.state, 'closed');
  assert.equal(server.last.closed, true);
  assert.equal(dl.shrine!.client.pendingTimers, 0);
});

// ---------------------------------------------------------------------------------------------------------
// key resolution

test('resolveShrineKey: env wins, then ~/.dexterm/shrine.key; implausible or missing means no key', () => {
  const home = mkdtempSync(join(tmpdir(), 'shrine-key-'));
  try {
    assert.equal(resolveShrineKey({ env: {}, home }), null);
    mkdirSync(join(home, '.dexterm'));
    writeFileSync(join(home, '.dexterm', 'shrine.key'), `  ${KEY}\n`);
    assert.deepEqual(resolveShrineKey({ env: {}, home }), { key: KEY, basis: '~/.dexterm/shrine.key' });
    assert.deepEqual(resolveShrineKey({ env: { DEXTERM_SHRINE_KEY: 'env_key_abcdef12' }, home }), { key: 'env_key_abcdef12', basis: 'env DEXTERM_SHRINE_KEY' });
    writeFileSync(join(home, '.dexterm', 'shrine.key'), 'not a key, a sentence');
    assert.equal(resolveShrineKey({ env: {}, home }), null);
    assert.equal(resolveShrineKey({ env: {}, readFile: () => { throw new Error('EACCES'); } }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('base58 helpers round-trip the FOMO accounts used above', () => {
  for (const k of [MINT, POOL, BASE_VAULT, QUOTE_VAULT]) assert.equal(base58(base58Decode(k)), k);
});

test('the Shrine key never serialises or inspects with the adapter or its socket', async () => {
  const { inspect } = await import('node:util');
  const server = fomoServer();
  const shrine = new Shrine({ apiKey: KEY, accounts: reader({}), clock: new FakeClock(NOW), socket: { ws: server.factory, timers: new ManualTimers() } });
  for (const obj of [shrine, shrine.client]) {
    assert.ok(!JSON.stringify(obj, (_k, v) => (typeof v === 'function' ? undefined : v)).includes(KEY), 'JSON');
    assert.ok(!inspect(obj, { depth: 8, showHidden: true }).includes(KEY), 'inspect');
  }
  shrine.close();
});
