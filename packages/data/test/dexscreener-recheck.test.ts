// DexScreener's batch endpoint can omit a coin's live pair (MEGA, 2026-10-18). A dead-looking best pair is
// rechecked once against the per-token endpoint; the recorder's budgeted sweep opts out.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeClock } from '../src/clock.ts';
import { HealthRegistry } from '../src/health.ts';
import { HttpClient, type Transport } from '../src/http.ts';
import { RateLimiter, DEFAULT_BUCKETS } from '../src/limiter.ts';
import { DexScreener } from '../src/sources/dexscreener.ts';
import { json } from './helpers.ts';

const MINT = 'megaA5QDK1qLXtjpvg9oCFMvxT9d5BCMrVTBddnM5kV';
const pair = (addr: string, dexId: string, liq: number, h24: number) => ({
  chainId: 'solana', dexId, pairAddress: addr, url: '', baseToken: { address: MINT, name: 'Make Europe Great Again', symbol: 'MEGA' },
  quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', symbol: 'SOL' },
  priceUsd: '0.0001', priceChange: { m5: 0, h1: 0, h6: 0, h24 }, liquidity: { usd: liq }, volume: { m5: 0, h1: 0, h6: 0, h24: 1000 },
  txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 0, sells: 0 }, h6: { buys: 0, sells: 0 }, h24: { buys: 1, sells: 1 } }, fdv: 80_000, marketCap: 80_000, pairCreatedAt: 1_700_000_000_000,
});

function rig() {
  const calls: string[] = [];
  const transport: Transport = async (req) => {
    calls.push(req.url);
    if (req.url.includes('/tokens/v1/')) return json(200, [pair('DeadMeteora', 'meteora', 70.5, -99.99)]);
    if (req.url.includes('/token-pairs/v1/')) return json(200, [pair('DeadMeteora', 'meteora', 70.5, -99.99), pair('LiveRaydium', 'raydium', 50_107, -4.5)]);
    return json(404, {});
  };
  const clock = new FakeClock(0);
  const http = new HttpClient({ transport, limiter: new RateLimiter(DEFAULT_BUCKETS, clock), health: new HealthRegistry({ clock }), clock });
  return { ds: new DexScreener(http), calls };
}

test('a dead-looking batch pair is rechecked per token and the live pair wins', async () => {
  const { ds, calls } = rig();
  const v = (await ds.tokens([MINT])).get(MINT)!;
  assert.equal(v.pair.pairAddress, 'LiveRaydium');
  assert.equal(v.pair.liquidityUsd, 50_107);
  assert.equal(calls.filter((u) => u.includes('/token-pairs/v1/')).length, 1);
});

test('the budgeted caller can opt out: one batch request, the batch answer kept', async () => {
  const { ds, calls } = rig();
  const v = (await ds.tokens([MINT], { recheckDead: false })).get(MINT)!;
  assert.equal(v.pair.pairAddress, 'DeadMeteora');
  assert.equal(calls.length, 1);
});
