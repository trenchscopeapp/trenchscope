// task-1312: two-speed fast lane — on-chain pump.fun curve decode, bonding-curve PDA derivation,
// Solana WS accountSubscribe client (reconnect/resubscribe/decode), and the FastLane coordinator
// (track/cap, LIVE vs POLL badge honesty, migrate demotion, endpoint failover, credit degradation).
// Pure + deterministic: a FakeClock and a scripted FakeWs, no network and no real timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock, flushMicrotasks } from '../src/clock.ts';
import { HealthRegistry } from '../src/health.ts';
import { CreditMeter } from '../src/credits.ts';
import type { StreamRecording } from '../src/fixtures.ts';
import { decodeBondingCurve, marketCapSol, curvePriceUsd } from '../src/sources/pump-curve.ts';
import { base58Decode, isOnCurve, pumpBondingCurve, isPumpMint } from '../src/sources/pda.ts';
import { base58 } from '../src/sources/solana-rpc.ts';
import { SolanaWsClient } from '../src/sources/solana-ws.ts';
import { FastLane, type SeedSource } from '../src/fast-lane.ts';
import type { WsLike } from '../src/sources/pumpportal.ts';

// ---------------------------------------------------------------- helpers

/** Build a base64 pump.fun bonding-curve account with the given reserves (SOL/token in whole units). */
function curveBase64(opts: { vSol: number; vToken: number; totalSupply: number; complete?: boolean }): string {
  const buf = Buffer.alloc(49);
  buf.writeBigUInt64LE(BigInt(Math.round(opts.vToken * 1e6)), 8);
  buf.writeBigUInt64LE(BigInt(Math.round(opts.vSol * 1e9)), 16);
  buf.writeBigUInt64LE(0n, 24);
  buf.writeBigUInt64LE(0n, 32);
  buf.writeBigUInt64LE(BigInt(Math.round(opts.totalSupply * 1e6)), 40);
  buf.writeUInt8(opts.complete ? 1 : 0, 48);
  return buf.toString('base64');
}

/** Scripted fake WebSocket (same shape as task-1298's). The test decides when it opens/says/drops. */
class FakeWs implements WsLike {
  readyState = 0;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private handlers: Record<string, ((ev: { data?: unknown; code?: number; reason?: string }) => void)[]> = {};
  readonly url: string;
  constructor(url: string) { this.url = url; }
  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void { this.closed = { code, reason }; }
  addEventListener(type: string, fn: (ev: { data?: unknown; code?: number; reason?: string; message?: string }) => void): void { (this.handlers[type] ??= []).push(fn); }
  fire(type: string, ev: { data?: unknown; code?: number; reason?: string; message?: string } = {}): void { for (const fn of this.handlers[type] ?? []) fn(ev); }
  /** Last subscribe/unsubscribe request id sent (parse the JSON-RPC id). */
  lastReqId(): number { return JSON.parse(this.sent[this.sent.length - 1]).id; }
  reqIds(): number[] { return this.sent.map((s) => JSON.parse(s).id); }
}

function ackFor(ws: FakeWs, subId: number): void {
  ws.fire('message', { data: JSON.stringify({ jsonrpc: '2.0', result: subId, id: ws.lastReqId() }) });
}

function notify(ws: FakeWs, subId: number, base64: string, slot = 100): void {
  ws.fire('message', { data: JSON.stringify({ jsonrpc: '2.0', method: 'accountNotification', params: { subscription: subId, result: { context: { slot }, value: { data: [base64, 'base64'] } } } }) });
}

// ---------------------------------------------------------------- on-chain decode

test('pump-curve: decodes reserves, SOL price, market cap, USD, and complete flag', () => {
  const b64 = curveBase64({ vSol: 30, vToken: 1_073_000_000, totalSupply: 1_000_000_000 });
  const c = decodeBondingCurve(b64)!;
  assert.ok(c);
  assert.equal(c.complete, false);
  assert.ok(Math.abs(c.vSol - 30) < 1e-6 && Math.abs(c.vToken - 1_073_000_000) < 1);
  // price = 30 / 1.073e9 ≈ 2.796e-8 SOL per token
  assert.ok(Math.abs(c.priceSol! - 30 / 1_073_000_000) < 1e-20);
  // mcap ≈ priceSol × 1e9 supply ≈ 27.96 SOL (matches the spike's ~28 SOL)
  assert.ok(Math.abs(marketCapSol(c)! - 27.96) < 0.1, `mcap ${marketCapSol(c)}`);
  assert.ok(Math.abs(curvePriceUsd(c, 116.09)! - c.priceSol! * 116.09) < 1e-18);
  assert.equal(curvePriceUsd(c, null), null, 'no SOL/USD → null USD');
  assert.equal(decodeBondingCurve('')!, null);
  assert.equal(decodeBondingCurve('AAAA'), null, 'too short → null');
  assert.equal(decodeBondingCurve(curveBase64({ vSol: 30, vToken: 1e9, totalSupply: 1e9, complete: true }))!.complete, true);
});

// ---------------------------------------------------------------- PDA derivation

test('pda: derives the pump.fun bonding curve for live-harvested mint→curve pairs (bumps 255/254/253)', () => {
  // From task-1283 research/hyper-speed/results/watchlist.json (live PumpPortal creates).
  const pairs: [string, string][] = [
    ['3yf6xEtqBJt8mkJ78miXj51s5huW2DyghneWZvxLpump', '9shfN7qDWRMXbRhbR27GbvdMsrG4VmEEBoHvuZmFSfMV'], // bump 255
    ['BvcBzQr8MYQVfiD35enYYMnjckWGeSJQsB7yGyyEpump', '8ePVsw2Y95FT4Huyac1AVnG4uFh431BNAXw4TH4fAVY2'], // bump 253
    ['EaD4STv3YNLaq2dpKWh6JaZTLLs9MAEHyyNUMfMUpump', '3XN8yQjhPDeeH7dYQfdyJMf96SMRk1EZiHUowNZXKPmx'], // bump 254
  ];
  for (const [mint, curve] of pairs) assert.equal(pumpBondingCurve(mint), curve, `curve for ${mint}`);
  assert.equal(isPumpMint('EaD4STv3YNLaq2dpKWh6JaZTLLs9MAEHyyNUMfMUpump'), true);
  assert.equal(isPumpMint('So11111111111111111111111111111111111111112'), false);
  // base58 round-trips and the on-curve test distinguishes a real pubkey from a PDA.
  const wsol = 'So11111111111111111111111111111111111111112';
  assert.equal(base58(base58Decode(wsol)), wsol);
  assert.equal(isOnCurve(base58Decode(wsol)), true, 'a normal pubkey is on the curve');
  assert.equal(isOnCurve(base58Decode('9shfN7qDWRMXbRhbR27GbvdMsrG4VmEEBoHvuZmFSfMV')), false, 'a PDA is off the curve');
});

// ---------------------------------------------------------------- Solana WS client

test('solana-ws: subscribes desired accounts on open, decodes notifications, resubscribes after reconnect', async () => {
  const clock = new FakeClock(1_000_000);
  const health = new HealthRegistry({ clock });
  const sockets: FakeWs[] = [];
  const updates: { account: string; slot: number | null }[] = [];
  let bytes = 0;
  const client = new SolanaWsClient({
    url: 'wss://rpc/?api-key=SECRET', source: 'helius-ws', clock, health,
    ws: (url) => { const s = new FakeWs(url); sockets.push(s); return s; },
    onAccount: (u) => updates.push({ account: u.account, slot: u.slot }),
    onBytes: (b) => { bytes += b; },
  });
  client.subscribe('CURVE_A');
  client.subscribe('CURVE_B');
  client.start();
  assert.equal(sockets.length, 1);
  sockets[0].fire('open');
  assert.equal(client.getStatus().state, 'open');
  // two accountSubscribe frames sent on open
  const subs = sockets[0].sent.map((s) => JSON.parse(s));
  assert.deepEqual(subs.map((m) => m.method), ['accountSubscribe', 'accountSubscribe']);
  assert.deepEqual(subs.map((m) => m.params[0]), ['CURVE_A', 'CURVE_B']);
  assert.equal(subs[0].params[1].commitment, 'processed');
  // ack both → active == 2
  sockets[0].fire('message', { data: JSON.stringify({ jsonrpc: '2.0', result: 11, id: subs[0].id }) });
  sockets[0].fire('message', { data: JSON.stringify({ jsonrpc: '2.0', result: 12, id: subs[1].id }) });
  assert.equal(client.getStatus().active, 2);
  const b64 = curveBase64({ vSol: 31, vToken: 1e9, totalSupply: 1e9 });
  notify(sockets[0], 11, b64, 500);
  assert.deepEqual(updates, [{ account: 'CURVE_A', slot: 500 }]);
  assert.ok(bytes > 0, 'streamed bytes metered');
  assert.equal(health.state('helius-ws'), 'ok');
  // drop → reconnect after 1 s, resubscribe BOTH accounts on the new socket
  sockets[0].fire('close', { code: 1006 });
  assert.equal(client.getStatus().state, 'reconnecting');
  assert.equal(client.getStatus().active, 0, 'subs cleared on drop');
  await clock.advance(1_000);
  assert.equal(sockets.length, 2);
  sockets[1].fire('open');
  const resub = sockets[1].sent.map((s) => JSON.parse(s).params[0]);
  assert.deepEqual(resub, ['CURVE_A', 'CURVE_B'], 'resubscribed the desired set');
  // unsubscribe one: active drops, an accountUnsubscribe is sent
  ackFor(sockets[1], 21); // ack CURVE_A (not strictly matched here; just exercise)
  client.unsubscribe('CURVE_B');
  assert.equal(client.getStatus().desired, 1);
  // never leaks the key in lastError
  sockets[1].fire('error', { message: 'boom wss://rpc/?api-key=SECRET' });
  assert.ok(!client.getStatus().lastError!.includes('SECRET'), 'key redacted in error');
  client.stop();
  assert.equal(client.getStatus().state, 'stopped');
});

test('solana-ws: health degrades after repeated failed connects; replay drives the same decode path', async () => {
  const clock = new FakeClock(5_000_000);
  const health = new HealthRegistry({ clock });
  const client = new SolanaWsClient({ url: 'wss://x', clock, health, ws: () => { throw new Error('ECONNREFUSED'); } });
  client.subscribe('C1');
  client.start();
  await clock.advance(1_000);
  await clock.advance(2_000);
  assert.equal(client.getStatus().failures, 3);
  assert.equal(health.state('solana-ws'), 'degraded');
  client.stop();
  // replay a recording through the same handler: seed subs from the recorded subscribe frame
  const b64 = curveBase64({ vSol: 32, vToken: 1e9, totalSupply: 1e9 });
  const rec: StreamRecording = {
    url: 'wss://x', startedAt: '',
    sent: [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'accountSubscribe', params: ['CURVE_R', { encoding: 'base64', commitment: 'processed' }] })],
    messages: [
      { tMs: 0, text: JSON.stringify({ jsonrpc: '2.0', result: 77, id: 1 }) },
      { tMs: 10, text: JSON.stringify({ jsonrpc: '2.0', method: 'accountNotification', params: { subscription: 77, result: { context: { slot: 9 }, value: { data: [b64, 'base64'] } } } }) },
    ],
  };
  const got: string[] = [];
  const player = new SolanaWsClient({ url: 'wss://x', clock, ws: () => { throw new Error('never'); }, onAccount: (u) => got.push(u.account) });
  await player.replay(rec, 0);
  assert.deepEqual(got, ['CURVE_R']);
  assert.equal(player.getStatus().notifications, 1);
});

// ---------------------------------------------------------------- FastLane

function fakeSeed(returns: Record<string, string | null> = {}): SeedSource {
  return { accountsRaw: async (accounts) => ({ data: new Map(accounts.map((a) => [a, returns[a] ?? null])), fetchedAt: 0 }) };
}

const PUMP_MINT = 'EaD4STv3YNLaq2dpKWh6JaZTLLs9MAEHyyNUMfMUpump';
const PUMP_CURVE = '3XN8yQjhPDeeH7dYQfdyJMf96SMRk1EZiHUowNZXKPmx';

test('fast-lane: tracks a pump mint (derives its curve), badge POLL→LIVE on the first push, migrate demotes', async () => {
  const clock = new FakeClock(2_000_000);
  const health = new HealthRegistry({ clock });
  const sockets: FakeWs[] = [];
  const prices: { mint: string; priceUsd: number | null; lane: string }[] = [];
  const fl = new FastLane({
    rpcPool: fakeSeed(), health, clock, solUsd: () => 116.09,
    endpoints: [{ url: 'wss://pub', source: 'solana-ws', keyed: false, label: 'public RPC ws' }],
    ws: (url) => { const s = new FakeWs(url); sockets.push(s); return s; },
    onPrice: (p) => prices.push({ mint: p.mint, priceUsd: p.priceUsd, lane: p.lane }),
  });
  fl.start();
  assert.equal(fl.track(PUMP_MINT), true, 'pump mint promoted to fast');
  // its derived curve is the subscribe target
  assert.equal(fl.resolvePriceAccount(PUMP_MINT).curve, PUMP_CURVE);
  // before the socket opens → POLL
  assert.equal(fl.badgeFor(PUMP_MINT), 'POLL');
  sockets[0].fire('open');
  const sub = JSON.parse(sockets[0].sent[0]);
  assert.equal(sub.params[0], PUMP_CURVE);
  // subscribed but not yet acked → still POLL
  assert.equal(fl.badgeFor(PUMP_MINT), 'POLL');
  ackFor(sockets[0], 55);
  // acked but no push yet → honestly still POLL (LIVE means a real on-chain push arrived)
  assert.equal(fl.badgeFor(PUMP_MINT), 'POLL');
  notify(sockets[0], 55, curveBase64({ vSol: 31, vToken: 1e9, totalSupply: 1e9 }), 700);
  // first push → LIVE / fast
  assert.equal(fl.badgeFor(PUMP_MINT), 'LIVE');
  assert.equal(fl.laneFor(PUMP_MINT), 'fast');
  const last = fl.price(PUMP_MINT)!;
  assert.ok(last && last.lane === 'fast' && last.source === 'onchain-curve' && last.priceUsd! > 0);
  assert.equal(fl.status().subscriptions, 1);
  assert.equal(fl.status().live, 1);
  // a 'complete' (migrated) curve demotes the token to the slow lane honestly
  notify(sockets[0], 55, curveBase64({ vSol: 85, vToken: 1e9, totalSupply: 1e9, complete: true }), 800);
  assert.equal(fl.badgeFor(PUMP_MINT), 'POLL', 'migrated → POLL');
  assert.equal(fl.laneFor(PUMP_MINT), 'slow');
  // non-pump mint is not streamable → stays slow, not subscribed
  assert.equal(fl.track('So11111111111111111111111111111111111111112'), false);
  fl.stop();
});

test('fast-lane: cap keeps extra tokens on the slow lane; stale push falls back to POLL', async () => {
  const clock = new FakeClock(3_000_000);
  const health = new HealthRegistry({ clock });
  const sockets: FakeWs[] = [];
  const fl = new FastLane({
    rpcPool: fakeSeed(), health, clock, solUsd: () => 100,
    endpoints: [{ url: 'wss://pub', source: 'solana-ws', keyed: false, label: 'public RPC ws' }],
    ws: (url) => { const s = new FakeWs(url); sockets.push(s); return s; },
    cap: 2,
  });
  fl.start();
  sockets[0].fire('open');
  // two known-curve mints fill the cap; a third is rejected (stays slow)
  assert.equal(fl.track('m1pump', 'CURVE1'), true);
  assert.equal(fl.track('m2pump', 'CURVE2'), true);
  assert.equal(fl.track('m3pump', 'CURVE3'), false, 'over cap → slow');
  assert.equal(fl.status().tracked, 2);
  // ack both subscribes (ids 1=CURVE1, 2=CURVE2) and push a tick on m1pump's curve
  sockets[0].fire('message', { data: JSON.stringify({ jsonrpc: '2.0', result: 101, id: 1 }) });
  sockets[0].fire('message', { data: JSON.stringify({ jsonrpc: '2.0', result: 102, id: 2 }) });
  notify(sockets[0], 101, curveBase64({ vSol: 30, vToken: 1e9, totalSupply: 1e9 }), 10);
  assert.equal(fl.badgeFor('m1pump'), 'LIVE');
  assert.equal(fl.badgeFor('m2pump'), 'POLL', 'subscribed but no push yet → POLL');
  // after LIVE_FRESHNESS_MS with no new push, the badge honestly reverts to POLL
  await clock.advance(91_000);
  assert.equal(fl.badgeFor('m1pump'), 'POLL', 'stale → POLL');
});

test('fast-lane: fails over to a keyless endpoint when the keyed Helius credit budget is spent', async () => {
  const clock = new FakeClock(4_000_000);
  const health = new HealthRegistry({ clock, keys: { helius: true } });
  // a credit meter already at the run cap → level() degraded
  const credits = new CreditMeter({ clock, runCap: 1 });
  credits.charge(5);
  assert.equal(credits.level(), 'degraded');
  const sockets: FakeWs[] = [];
  const fl = new FastLane({
    rpcPool: fakeSeed(), health, clock, credits, solUsd: () => 100,
    endpoints: [
      { url: 'wss://helius/?api-key=K', source: 'helius-ws', keyed: true, label: 'Helius (free key)' },
      { url: 'wss://pub', source: 'solana-ws', keyed: false, label: 'public RPC ws' },
    ],
    ws: (url) => { const s = new FakeWs(url); sockets.push(s); return s; },
  });
  fl.start();
  assert.equal(fl.endpoint.keyed, true);
  sockets[0].fire('open');
  fl.track('kpump', 'CURVEK');
  ackFor(sockets[0], 1);
  // keyed stream but credits spent → not actually delivering → POLL
  assert.equal(fl.badgeFor('kpump'), 'POLL', 'keyed + credits degraded → POLL');
  // a metered byte triggers the degrade check → rotate to the keyless endpoint
  notify(sockets[0], 1, curveBase64({ vSol: 30, vToken: 1e9, totalSupply: 1e9 }), 5);
  assert.equal(fl.endpoint.keyed, false, 'rotated to keyless public ws');
  assert.ok(sockets.length >= 2, 'reopened on the keyless endpoint');
});

test('fast-lane: repeated ws failures roll over to the next endpoint', async () => {
  const clock = new FakeClock(6_000_000);
  const health = new HealthRegistry({ clock });
  let primaryTries = 0;
  const built: string[] = [];
  const fl = new FastLane({
    rpcPool: fakeSeed(), health, clock, solUsd: () => 100,
    endpoints: [
      { url: 'wss://a', source: 'solana-ws', keyed: false, label: 'A' },
      { url: 'wss://b', source: 'solana-ws', keyed: false, label: 'B' },
    ],
    ws: (url) => {
      built.push(url);
      if (url === 'wss://a') { primaryTries++; throw new Error('refused'); }
      const s = new FakeWs(url); return s;
    },
  });
  fl.start();
  // endpoint A throws on connect → retries with backoff; after 3 failures it rotates to B
  await clock.advance(1_000);
  await clock.advance(2_000);
  await flushMicrotasks();
  assert.ok(fl.endpoint.label === 'B', `rotated to B (was ${fl.endpoint.label})`);
  assert.ok(built.includes('wss://b'));
  fl.stop();
});
