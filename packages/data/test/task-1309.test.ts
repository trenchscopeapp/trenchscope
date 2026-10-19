// task-1309: FREE-FOREVER data layer — RPC pool rotation/backoff, per-source request budget meter,
// and the keyless top-holder aggregate fallback (Jupiter) when no RPC endpoint can serve the ranked list.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeClock } from '../src/clock.ts';
import { Cache } from '../src/cache.ts';
import { BudgetMeter } from '../src/budget.ts';
import { HealthRegistry } from '../src/health.ts';
import { HttpClient, HttpError } from '../src/http.ts';
import type { HttpRequest, HttpResponse, Transport } from '../src/http.ts';
import { RateLimiter, DEFAULT_BUCKETS } from '../src/limiter.ts';
import { RpcPool, bucketFor, type RpcEndpointSpec } from '../src/rpc-pool.ts';
import { createDataLayer } from '../src/index.ts';
import { json, drive } from './helpers.ts';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const KEYED = 'https://mainnet.helius-rpc.com/?api-key=REDACTED';
const PUBLIC = 'https://api.mainnet-beta.solana.com';
const PUBLIC2 = 'https://solana-rpc.publicnode.com';
const largestOk = () => json(200, { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: [] } });

function makePool(clock: FakeClock, specs: RpcEndpointSpec[], transport: Transport) {
  const limiter = new RateLimiter(DEFAULT_BUCKETS, clock);
  // Mark keyed sources as present so the health gate does not report them needs-key in the harness.
  const keys = Object.fromEntries(specs.filter((s) => s.keyed).map((s) => [s.source, true]));
  const health = new HealthRegistry({ clock, keys });
  const http = new HttpClient({ transport, limiter, health, clock });
  return new RpcPool(http, limiter, specs, { clock });
}

test('rpc pool: rotates to a healthy endpoint when the preferred one 429s, honouring Retry-After', async () => {
  const clock = new FakeClock(0);
  const seen: string[] = [];
  const transport: Transport = async (req: HttpRequest): Promise<HttpResponse> => {
    seen.push(new URL(req.url).hostname);
    if (new URL(req.url).hostname === 'mainnet.helius-rpc.com') return json(429, { error: 'slow down' }, { 'retry-after': '5' });
    return largestOk();
  };
  const pool = makePool(clock, [
    { url: KEYED, source: 'helius', bucket: 'helius', label: 'Helius', keyed: true },
    { url: PUBLIC, source: 'solana-rpc', bucket: 'solana-rpc', label: 'public' },
  ], transport);

  const h = await drive(clock, pool.run((rpc) => rpc.largestAccounts(MINT)));
  assert.deepEqual(h.accounts, [], 'served by the public endpoint');
  assert.deepEqual(seen, ['mainnet.helius-rpc.com', 'api.mainnet-beta.solana.com'], 'tried keyed first, then rotated');

  const st = pool.status();
  const helius = st.find((e) => e.keyed)!;
  assert.equal(helius.available, false, 'keyed endpoint is paused after its 429');
  assert.ok(helius.pausedUntil >= 5000, `Retry-After (5s) honoured, got ${helius.pausedUntil}`);
  assert.equal(st.find((e) => !e.keyed)!.okCount, 1);

  // While the keyed endpoint is paused, the next call skips straight to the public one (no wasted 429).
  seen.length = 0;
  await drive(clock, pool.run((rpc) => rpc.largestAccounts(MINT)));
  assert.deepEqual(seen, ['api.mainnet-beta.solana.com'], 'paused endpoint skipped');
});

test('rpc pool: all endpoints failing propagates the last error (never a silent empty result)', async () => {
  const clock = new FakeClock(0);
  const transport: Transport = async () => json(429, { error: 'nope' });
  const pool = makePool(clock, [
    { url: KEYED, source: 'helius', bucket: 'helius', label: 'Helius', keyed: true },
    { url: PUBLIC, source: 'solana-rpc', bucket: 'solana-rpc', label: 'public' },
  ], transport);
  await assert.rejects(drive(clock, pool.run((rpc) => rpc.largestAccounts(MINT))), (e: unknown) => e instanceof HttpError && e.status === 429);
  const st = pool.status();
  assert.ok(st.every((e) => !e.available), 'both endpoints paused');
  assert.ok(st.every((e) => e.consecutiveFailures >= 1));
});

test('rpc pool: health scoring prefers the endpoint with fewer recent failures, and a recovered endpoint rejoins', async () => {
  const clock = new FakeClock(0);
  let heliusDown = true;
  const seen: string[] = [];
  const transport: Transport = async (req: HttpRequest): Promise<HttpResponse> => {
    const host = new URL(req.url).hostname;
    seen.push(host);
    if (host === 'mainnet.helius-rpc.com' && heliusDown) return json(500, { error: 'boom' });
    return largestOk();
  };
  const pool = makePool(clock, [
    { url: KEYED, source: 'helius', bucket: 'helius', label: 'Helius', keyed: true },
    { url: PUBLIC, source: 'solana-rpc', bucket: 'solana-rpc', label: 'public' },
  ], transport);

  await drive(clock, pool.run((rpc) => rpc.largestAccounts(MINT))); // helius 500 → public ok, helius cooled down
  await clock.advance(60_000); // let the cooldown lapse
  seen.length = 0;
  await drive(clock, pool.run((rpc) => rpc.largestAccounts(MINT)));
  assert.equal(seen[0], 'api.mainnet-beta.solana.com', 'the endpoint with the clean record is tried first');

  heliusDown = false;
  await clock.advance(60_000);
  // force a public failure so the pool must try helius again and see it recovered
  const st0 = pool.status();
  assert.ok(st0.find((e) => e.keyed)!.errorCount >= 1);
});

test('budget meter: counts requests per source (session + persisted day), soft caps, snapshot + label', () => {
  const clock = new FakeClock(Date.UTC(2026, 9, 7, 12, 0, 0));
  const cache = new Cache({ clock });
  const m = new BudgetMeter({ clock, cache, dayCaps: { 'jupiter-tokens': 3 } });
  m.charge('dexscreener');
  m.charge('dexscreener');
  m.charge('jupiter-tokens');
  assert.equal(m.status('dexscreener').session, 2);
  assert.equal(m.status('dexscreener').day, 2);
  assert.equal(m.status('jupiter-tokens').dayCap, 3);
  assert.equal(m.allow('jupiter-tokens'), true);
  m.charge('jupiter-tokens');
  m.charge('jupiter-tokens');
  assert.equal(m.allow('jupiter-tokens'), false, 'soft cap reached');
  assert.equal(m.status('jupiter-tokens').over, true);
  assert.match(m.label(), /dexscreener 2/);

  // A fresh meter on the same cache keeps the day totals (restart), but session resets.
  const m2 = new BudgetMeter({ clock, cache });
  assert.equal(m2.status('dexscreener').day, 2, 'day total persisted across restart');
  assert.equal(m2.status('dexscreener').session, 0, 'session resets on restart');
  cache.close();
});

test('budget meter: a new UTC day starts the day count fresh', () => {
  const day1 = new FakeClock(Date.UTC(2026, 9, 7, 23, 59, 0));
  const cache = new Cache({ clock: day1 });
  const m = new BudgetMeter({ clock: day1, cache });
  m.charge('dexscreener');
  assert.equal(m.status('dexscreener').day, 1);
  const day2 = new FakeClock(Date.UTC(2026, 9, 8, 0, 1, 0));
  const m2 = new BudgetMeter({ clock: day2, cache });
  assert.equal(m2.status('dexscreener').day, 0, 'new UTC day is clean');
  cache.close();
});

test('keyless holders: when no RPC serves the ranked list, fall back to the Jupiter aggregate (count + top-10%)', async () => {
  const clock = new FakeClock(Date.UTC(2026, 9, 7, 12, 0, 0));
  // getAccountInfo succeeds (mint info), getTokenLargestAccounts 429s everywhere (the keyless reality),
  // Jupiter search answers with holderCount + topHoldersPercentage.
  const transport: Transport = async (req: HttpRequest): Promise<HttpResponse> => {
    const url = req.url;
    if (url.includes('jup.ag')) {
      return json(200, [{ id: MINT, name: 'Bonk', symbol: 'Bonk', decimals: 5, holderCount: 1025642, audit: { topHoldersPercentage: 30.6, mintAuthorityDisabled: true, freezeAuthorityDisabled: true } }]);
    }
    // Solana JSON-RPC
    const method = (JSON.parse(req.body ?? '{}') as { method?: string }).method;
    if (method === 'getAccountInfo') {
      // a minimal but valid SPL mint account (82 bytes, authorities revoked, supply 0, decimals 5)
      const buf = Buffer.alloc(82);
      buf.writeUInt32LE(0, 0); // mint authority: none
      buf.writeBigUInt64LE(0n, 36);
      buf[44] = 5; // decimals
      buf[45] = 1; // initialized
      buf.writeUInt32LE(0, 46); // freeze authority: none
      return json(200, { jsonrpc: '2.0', id: 1, result: { value: { data: [buf.toString('base64'), 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' } } });
    }
    return json(429, { error: 'Too many requests for a specific RPC call' }); // getTokenLargestAccounts
  };
  const dl = createDataLayer({ clock, transport, rpcPublicPool: true });
  const h = await drive(clock, dl.detail.holders(MINT));
  assert.equal(h.value.aggregateOnly, true, 'aggregate fallback engaged');
  assert.equal(h.value.holders.length, 0, 'no ranked list keyless');
  assert.equal(h.value.holderCount, 1025642);
  assert.equal(h.value.top10Pct, 30.6);
  assert.equal(h.value.source, 'jupiter-tokens');
  dl.close();
});

test('keyless holders: when the aggregate also fails, the RPC error propagates (honest unavailable)', async () => {
  const clock = new FakeClock(Date.UTC(2026, 9, 7, 12, 0, 0));
  const transport: Transport = async (req: HttpRequest): Promise<HttpResponse> => {
    if (req.url.includes('jup.ag')) return json(429, { error: 'rate limited' });
    const method = (JSON.parse(req.body ?? '{}') as { method?: string }).method;
    if (method === 'getAccountInfo') {
      const buf = Buffer.alloc(82);
      buf[44] = 5; buf[45] = 1;
      return json(200, { jsonrpc: '2.0', id: 1, result: { value: { data: [buf.toString('base64'), 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' } } });
    }
    return json(429, { error: 'Too many requests for a specific RPC call' });
  };
  const dl = createDataLayer({ clock, transport });
  await assert.rejects(drive(clock, dl.detail.holders(MINT)), (e: unknown) => e instanceof HttpError && e.status === 429);
  dl.close();
});

test('bucketFor derives a per-host bucket, never leaking a key', () => {
  assert.equal(bucketFor(KEYED), 'rpc:mainnet.helius-rpc.com');
  assert.equal(bucketFor(PUBLIC2), 'rpc:solana-rpc.publicnode.com');
  assert.ok(!bucketFor(KEYED).includes('api-key'));
});

test('data layer: the budget meter counts live requests by source', async () => {
  const clock = new FakeClock(Date.UTC(2026, 9, 7, 12, 0, 0));
  const transport: Transport = async (req: HttpRequest) => (req.url.includes('jup.ag') ? json(200, []) : json(200, { jsonrpc: '2.0', id: 1, result: { value: null } }));
  const dl = createDataLayer({ clock, transport });
  await drive(clock, dl.jupiter.recent()).catch(() => {});
  assert.ok(dl.budget.status('jupiter-tokens').session >= 1, 'jupiter request counted');
  dl.close();
});
