import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replayTransport } from '../src/fixtures.ts';
import { COLUMN_SOURCES, gateAll } from '../src/health.ts';
import { mergeToken } from '../src/store.ts';
import { drive, json, loadSample, sampleLayer, spy } from './helpers.ts';

test('offline end-to-end: trending discovery + enrichment yields 30 rows from DexScreener + Jupiter fixtures', async () => {
  const { dl, clock } = sampleLayer();
  const disc = await drive(clock, dl.store.discover('trending', 30));
  assert.equal(disc.mints.length, 30);
  assert.deepEqual(disc.errors, {});
  assert.ok(Object.values(disc.origin).some((o) => o.includes('ds:boosts-top')));
  assert.ok(Object.values(disc.origin).some((o) => o.includes('jup:toptrending-1h')));

  const res = await drive(clock, dl.store.enrich(disc.mints, { price: true }));
  assert.deepEqual(res.errors, {});
  assert.equal(res.rows.length + res.missing.length, 30);
  assert.ok(res.rows.length >= 28, `${res.rows.length} rows`);
  const both = res.rows.filter((r) => r.sources.includes('dexscreener') && r.sources.includes('jupiter-tokens'));
  assert.ok(both.length >= 25, `only ${both.length} rows had both sources`);
  assert.ok(res.rows.some((r) => r.sources.includes('jupiter-price')));
  for (const r of res.rows) {
    assert.equal(r.token.mint, r.mint);
    assert.equal(r.pair.baseMint, r.mint);
    assert.equal(r.stale, false);
    if (r.sources.includes('jupiter-tokens')) {
      assert.ok(r.stats && r.audit);
      assert.equal(r.token.source, 'jupiter-tokens', 'Jupiter wins identity fields');
    }
    if (r.sources.includes('dexscreener')) assert.equal(r.pair.source, 'dexscreener', 'DexScreener wins the pair');
  }
  dl.close();
});

test('enrichment is cached per mint: a repeat inside the TTL makes no requests; pairs refresh after 10 s', async () => {
  const fixtures = loadSample();
  const t = spy(replayTransport(fixtures));
  const { dl, clock } = sampleLayer({ transport: t });
  const disc = await drive(clock, dl.store.discover('trending', 30));
  await drive(clock, dl.store.enrich(disc.mints, { price: true }));
  const n = t.calls.length;
  await drive(clock, dl.store.enrich(disc.mints, { price: true }));
  assert.equal(t.calls.length, n, 'served from cache');
  await clock.advance(11_000);
  const again = await drive(clock, dl.store.enrich(disc.mints));
  const extra = t.calls.slice(n);
  assert.equal(extra.length, 1);
  assert.match(extra[0], /api\.dexscreener\.com\/tokens\/v1/);
  assert.ok(again.latencyMs.dexscreener !== undefined && again.latencyMs['jupiter-tokens'] === undefined);
  dl.close();
});

test('degraded Jupiter: rows keep DexScreener data, enrichment columns gate off, then recover', async () => {
  const fixtures = loadSample();
  let jupDown = true;
  const t = spy(replayTransport(fixtures), (req) => (jupDown && req.url.includes('jup.ag') ? json(503, { error: 'down' }) : undefined));
  const { dl, clock } = sampleLayer({ transport: t });
  const mints = decodeURIComponent(fixtures.list().find((e) => e.url.includes('/tokens/v1/'))!.url.split('/solana/')[1]).split(',');

  // Three failing Jupiter calls demote the source.
  for (let i = 0; i < 3; i++) await drive(clock, dl.jupiter.recent().catch(() => undefined));
  assert.equal(dl.health.state('jupiter-tokens'), 'degraded');

  const res = await drive(clock, dl.store.enrich(mints));
  assert.ok(res.rows.length >= 25);
  assert.ok(res.rows.every((r) => r.sources.join() === 'dexscreener' && r.stats === undefined));
  assert.match(res.errors['jupiter-tokens'] ?? '', /jupiter-tokens is degraded/);
  const cols = gateAll(dl.health, COLUMN_SOURCES);
  assert.equal(cols.holders.state, 'degraded');
  assert.equal(cols.price.available, true);

  jupDown = false;
  await clock.advance(30_000); // backoff ends -> probing; the next success recovers
  assert.equal(dl.health.state('jupiter-tokens'), 'probing');
  await drive(clock, dl.jupiter.recent());
  assert.equal(dl.health.state('jupiter-tokens'), 'ok');
  assert.equal(gateAll(dl.health, COLUMN_SOURCES).holders.available, true);
  dl.close();
});

test('refresh failure serves stale rows flagged stale', async () => {
  const fixtures = loadSample();
  let dsDown = false;
  const t = spy(replayTransport(fixtures), (req) => (dsDown && req.url.includes('dexscreener') ? json(502, {}) : undefined));
  const { dl, clock } = sampleLayer({ transport: t });
  const mints = decodeURIComponent(fixtures.list().find((e) => e.url.includes('/tokens/v1/'))!.url.split('/solana/')[1]).split(',');
  const first = await drive(clock, dl.store.enrich(mints));
  dsDown = true;
  await clock.advance(11_000);
  const second = await drive(clock, dl.store.enrich(mints));
  assert.ok(second.errors.dexscreener);
  const staleRows = second.rows.filter((r) => r.stale);
  assert.ok(staleRows.length >= 25);
  assert.equal(staleRows[0].pair.source, 'dexscreener');
  assert.equal(second.rows.length, first.rows.length);
  dl.close();
});

test('mergeToken: Jupiter identity, DexScreener fills gaps', () => {
  const base = { source: 'dexscreener', fetchedAt: 1, mint: 'M', symbol: 'DS', name: 'ds', decimals: null, launchpad: 'pump.fun', createdAt: 5, image: 'ds.png', socials: { x: 'dsx', tg: 'dstg', web: null }, verified: false, sus: false } as const;
  const jup = { ...base, source: 'jupiter-tokens', symbol: 'J', decimals: 6, launchpad: 'unknown', createdAt: null, image: null, socials: { x: null, tg: null, web: 'jw' }, verified: true } as const;
  const m = mergeToken({ ...base, socials: { ...base.socials } }, { ...jup, socials: { ...jup.socials } });
  assert.equal(m.symbol, 'J');
  assert.equal(m.decimals, 6);
  assert.equal(m.launchpad, 'pump.fun');
  assert.equal(m.createdAt, 5);
  assert.equal(m.image, 'ds.png');
  assert.deepEqual(m.socials, { x: 'dsx', tg: 'dstg', web: 'jw' });
  assert.equal(m.verified, true);
});
