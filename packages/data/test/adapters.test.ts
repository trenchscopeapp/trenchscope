import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeClock } from '../src/clock.ts';
import { replayTransport } from '../src/fixtures.ts';
import { HealthRegistry } from '../src/health.ts';
import { HttpClient } from '../src/http.ts';
import type { Transport } from '../src/http.ts';
import { DEFAULT_BUCKETS, RateLimiter } from '../src/limiter.ts';
import type { Pair } from '../src/model.ts';
import { DS_TOKENS_BATCH, DexScreener } from '../src/sources/dexscreener.ts';
import { JUPITER_HOSTS, Jupiter, launchpadFromJupiter } from '../src/sources/jupiter.ts';
import { drive, json, loadSample, sampleClock, spy } from './helpers.ts';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function setup(transport?: Transport) {
  const fixtures = loadSample();
  const clock = sampleClock(fixtures);
  const limiter = new RateLimiter(DEFAULT_BUCKETS, clock);
  const health = new HealthRegistry({ clock });
  const t = spy(transport ?? replayTransport(fixtures));
  const http = new HttpClient({ transport: t, limiter, health, clock });
  return { fixtures, clock, t, health, ds: new DexScreener(http), jup: new Jupiter(http) };
}

/** Mints from a recorded tokens/v1 URL. */
function recordedDsMints(fixtures: ReturnType<typeof loadSample>): string[] {
  const e = fixtures.list().find((x) => x.url.includes('/tokens/v1/solana/'))!;
  return decodeURIComponent(e.url.split('/tokens/v1/solana/')[1]).split(',');
}

function assertPairShape(p: Pair) {
  assert.equal(typeof p.pairAddress, 'string');
  assert.ok(Number.isFinite(p.priceUsd));
  for (const w of ['m5', 'h1', 'h6', 'h24'] as const) {
    assert.ok(Number.isInteger(p.txns[w].buys) && Number.isInteger(p.txns[w].sells), `txns.${w}`);
    assert.ok(p.volume[w] === null || Number.isFinite(p.volume[w]));
    assert.ok(p.priceChange[w] === null || Number.isFinite(p.priceChange[w]));
  }
  assert.ok(p.fetchedAt > 0);
}

test('dexscreener tokens/v1: recorded batch normalizes to one best pair per mint', async () => {
  const { fixtures, ds } = setup();
  const mints = recordedDsMints(fixtures);
  assert.equal(mints.length, 30);
  const byMint = await ds.tokens(mints);
  assert.ok(byMint.size >= 25, `only ${byMint.size} mints resolved`);
  for (const [mint, v] of byMint) {
    assert.equal(v.pair.baseMint, mint);
    assert.equal(v.pair.source, 'dexscreener');
    assert.ok(v.pair.priceUsd > 0);
    assertPairShape(v.pair);
    assert.equal(v.token.mint, mint);
    assert.equal(v.token.decimals, null, 'DexScreener does not report decimals');
    assert.ok(['pump.fun', 'bonk', 'dbc', 'unknown'].includes(v.token.launchpad));
  }
});

test('dexscreener: batches of 30 mints per call', async () => {
  const { ds, t } = setup(async () => json(200, []));
  const mints = Array.from({ length: 61 }, (_, i) => `Mint${i}`);
  await ds.tokens(mints);
  assert.equal(t.calls.length, 3);
  assert.ok(t.calls.every((u) => decodeURIComponent(u).split('/solana/')[1].split(',').length <= DS_TOKENS_BATCH));
});

test('dexscreener boosts, search and token-pairs from fixtures', async () => {
  const { ds } = setup();
  const boosts = await ds.boostsTop();
  assert.ok(boosts.length > 0 && boosts.length <= 30);
  assert.equal(new Set(boosts.map((b) => b.mint)).size, boosts.length, 'deduplicated');
  const found = await ds.search('bonk');
  assert.ok(found.length > 0);
  for (const v of found) assertPairShape(v.pair);
  const pairs = await ds.tokenPairs(BONK);
  assert.ok(pairs.length > 0);
  assert.ok(pairs.every((p) => p.baseMint === BONK || p.quoteMint === BONK));
});

test('jupiter toptrending: tokens, stats and audit normalize from the recorded feed', async () => {
  const { jup, fixtures } = setup();
  const views = await jup.category('toptrending', '1h', 30);
  assert.equal(views.length, 30);
  const raw = fixtures.list().find((e) => e.url.includes('toptrending'))!.body as { id: string; mintAuthority?: string; audit?: { mintAuthorityDisabled?: boolean } }[];
  for (const v of views) {
    assert.equal(v.token.source, 'jupiter-tokens');
    assert.ok(v.token.decimals === null || Number.isInteger(v.token.decimals));
    assert.ok(v.stats.organicScore === null || (v.stats.organicScore >= 0 && v.stats.organicScore <= 100));
    assert.equal(v.stats.mint, v.token.mint);
    assert.equal(v.audit.mint, v.token.mint);
    assertPairShape(v.pair);
    const r = raw.find((x) => x.id === v.token.mint)!;
    if (r.audit?.mintAuthorityDisabled === true) assert.equal(v.audit.mintAuthority, false);
    if (r.audit?.mintAuthorityDisabled === undefined && r.mintAuthority) assert.equal(v.audit.mintAuthority, true, 'authority address present = enabled');
  }
  assert.ok(views.some((v) => v.stats.holderCount !== null && v.stats.holderCount > 0));
  assert.ok(views.some((v) => v.stats.perWindow.h24 !== null));
});

test('jupiter launchpad mapping', () => {
  assert.equal(launchpadFromJupiter('pump.fun', 'x'), 'pump.fun');
  assert.equal(launchpadFromJupiter('letsbonk.fun', 'x'), 'bonk');
  assert.equal(launchpadFromJupiter('raydium-launchlab', 'x'), 'raydium');
  assert.equal(launchpadFromJupiter('met-dbc', 'x'), 'dbc');
  assert.equal(launchpadFromJupiter('stonkfun', 'x'), 'unknown');
  assert.equal(launchpadFromJupiter(undefined, 'Abcpump'), 'pump.fun');
});

test('jupiter recent, toporganicscore and price v3 from fixtures (limiter-paced on the fake clock)', async () => {
  const { jup, clock, fixtures } = setup();
  const recent = await drive(clock, jup.recent());
  assert.equal(recent.length, 30);
  assert.ok(recent.every((v) => v.token.createdAt !== null));
  const organic = await drive(clock, jup.category('toporganicscore', '1h', 30));
  assert.equal(organic.length, 30);
  const priceUrl = fixtures.list().find((e) => e.url.includes('/price/v3'))!.url;
  const ids = new URL(priceUrl).searchParams.get('ids')!.split(',');
  const prices = await drive(clock, jup.price(ids));
  assert.ok(prices.size >= 25);
  for (const p of prices.values()) assert.ok(p.usdPrice > 0 && p.source === 'jupiter-price');
});

test('jupiter: falls back to lite-api when api.jup.ag refuses keyless access, and stays there', async () => {
  const t: Transport = async (req) => (req.url.startsWith(JUPITER_HOSTS[0]) ? json(401, { error: 'key required' }) : json(200, []));
  const { jup, t: calls, clock } = setup(t);
  await drive(clock, jup.recent());
  assert.equal(jup.host, JUPITER_HOSTS[1]);
  await drive(clock, jup.recent());
  assert.deepEqual(calls.calls.map((u) => new URL(u).host), ['api.jup.ag', 'lite-api.jup.ag', 'lite-api.jup.ag']);
});

test('jupiter: mint searches batch 100 per call and price 50 per call', async () => {
  const { jup, t, clock } = setup(async (req) => json(200, req.url.includes('/price/') ? {} : []));
  const mints = Array.from({ length: 150 }, (_, i) => `M${i}`);
  await drive(clock, jup.search(mints));
  await drive(clock, jup.price(mints));
  const search = t.calls.filter((u) => u.includes('/search'));
  const price = t.calls.filter((u) => u.includes('/price/'));
  assert.equal(search.length, 2);
  assert.equal(price.length, 3);
});

test('adapter calls share the limiter: identical in-flight calls coalesce, distinct ones are paced', async () => {
  const fake = new FakeClock(0);
  const limiter = new RateLimiter(DEFAULT_BUCKETS, fake);
  const t = spy(async () => json(200, []));
  const http = new HttpClient({ transport: t, limiter, health: new HealthRegistry({ clock: fake }), clock: fake });
  const jup = new Jupiter(http);
  await drive(fake, Promise.all(Array.from({ length: 6 }, () => jup.category('toptrending', '5m'))), 100);
  assert.equal(t.calls.length, 1, 'six identical in-flight calls -> one request');
  const start = fake.now();
  await drive(fake, Promise.all(['5m', '1h', '6h', '24h'].map((i) => jup.category('toporganicscore', i as '5m'))), 100);
  assert.equal(t.calls.length, 5);
  // Jupiter budget 21/min, burst 1: four requests need at least three ~2.86 s gaps after the first.
  assert.ok(fake.now() - start >= 3 * Math.floor(60_000 / 21), `elapsed ${fake.now() - start}ms`);
});
