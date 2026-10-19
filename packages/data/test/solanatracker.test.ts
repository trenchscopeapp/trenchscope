// Solana Tracker (keyed risk source): normaliser, audit patch, key resolution, and the key-handling
// guarantees: the key travels only in the x-api-key header of a GET, never in a URL, a recording or a log.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeClock } from '../src/clock.ts';
import { FixtureStore, recordingTransport } from '../src/fixtures.ts';
import { HealthRegistry } from '../src/health.ts';
import { HttpClient, liveTransport, type HttpRequest, type Transport } from '../src/http.ts';
import { RateLimiter, DEFAULT_BUCKETS } from '../src/limiter.ts';
import { SolanaTracker, normalizeTrackerToken, auditPatchFromTracker } from '../src/sources/solanatracker.ts';
import { resolveTrackerKey } from '../src/tracker-config.ts';
import { createDataLayer } from '../src/index.ts';
import { json } from './helpers.ts';

const MINT = 'So11111111111111111111111111111111111111112';
const KEY = 'trk_test_0123456789abcdef';

// Shape from docs.solanatracker.io (GET /tokens/{mint}) and our pump-signals client; risks carry both forms.
const SAMPLE = {
  token: { name: 'X', symbol: 'X', mint: MINT, creation: { creator: 'Creator1111111111111111111111111111111111111' } },
  pools: [
    { liquidity: { usd: 12_000 }, lpBurn: 0, curvePercentage: 64, deployer: 'Dep11111', security: { mintAuthority: null, freezeAuthority: null } },
    { liquidity: { usd: 90_000 }, lpBurn: 100, security: { mintAuthority: null, freezeAuthority: 'Frz1111' } },
  ],
  holders: 4321,
  risk: {
    score: 7,
    rugged: false,
    top10: 41.5,
    dev: { percentage: 12.25, amount: 1 },
    snipers: { count: 9, totalPercentage: 14 },
    insiders: { count: 3, totalPercentage: 6.5 },
    bundlers: { count: 5, totalPercentage: 22 },
    risks: ['Low liquidity', { name: 'Freeze Authority Enabled', level: 'danger', score: 5000, description: 'x' }, { name: 'Top 10 holders', level: 'warning', score: 300 }],
  },
};

test('normalizer: deepest pool decides curve state and authorities, best LP burn, both risk shapes, most severe first', () => {
  const t = normalizeTrackerToken(MINT, SAMPLE, 1000);
  assert.equal(t.score, 7);
  assert.equal(t.rugged, false);
  assert.equal(t.top10Pct, 41.5);
  assert.equal(t.devPct, 12.25);
  assert.deepEqual([t.sniperCount, t.sniperPct, t.insiderCount, t.insiderPct, t.bundlerCount, t.bundlerPct], [9, 14, 3, 6.5, 5, 22]);
  assert.equal(t.holders, 4321);
  assert.equal(t.lpBurnPct, 100);
  assert.equal(t.onCurve, null, 'the $90K pool has no curvePercentage: graduated, not on a curve');
  assert.equal(t.freezeAuthority, true);
  assert.equal(t.mintAuthority, false);
  assert.equal(t.creator, 'Creator1111111111111111111111111111111111111');
  assert.equal(t.liquidityUsd, 90_000);
  assert.deepEqual(t.risks.map((r) => r.name), ['Freeze Authority Enabled', 'Top 10 holders', 'Low liquidity']);
});

test('normalizer: an empty or junk body is all-null, never zeros', () => {
  for (const raw of [null, {}, [], 'x', { risk: { snipers: 'n/a', top10: 'abc' }, pools: [null, 3] }]) {
    const t = normalizeTrackerToken(MINT, raw, 1);
    assert.equal(t.score, null);
    assert.equal(t.top10Pct, null);
    assert.equal(t.sniperCount, null);
    assert.equal(t.bundlerPct, null);
    assert.equal(t.lpBurnPct, null);
    assert.equal(t.mintAuthority, null, 'an absent security block is unknown, not revoked');
    assert.deepEqual(t.risks, []);
    assert.deepEqual(auditPatchFromTracker(t), {}, 'nothing known: the patch erases nothing');
  }
});

test('audit patch: only known values, and no LP figure while the token is still on a bonding curve', () => {
  const curve = normalizeTrackerToken(MINT, { pools: [{ liquidity: { usd: 5000 }, lpBurn: 0, curvePercentage: 40 }], risk: { bundlers: { count: 2, totalPercentage: 30 } } }, 1);
  assert.equal(curve.onCurve, true);
  const p = auditPatchFromTracker(curve);
  assert.equal('lpLockedPct' in p, false, '0 % burned on a curve is meaningless, not a red flag');
  assert.equal(p.bundledPct, 30);
  assert.equal(p.bundlerCount, 2);
  const full = auditPatchFromTracker(normalizeTrackerToken(MINT, SAMPLE, 1));
  assert.equal(full.lpLockedPct, 100);
  assert.equal(full.devPct, 12.25);
  assert.equal(full.sniperCount, 9);
  assert.equal(full.trackerScore, 7);
});

test('key file: env wins, file is trimmed, junk or missing means no key, and nothing throws', () => {
  const home = mkdtempSync(join(tmpdir(), 'dexterm-trk-'));
  try {
    assert.equal(resolveTrackerKey({ env: {}, home }), null);
    mkdirSync(join(home, '.dexterm'));
    writeFileSync(join(home, '.dexterm', 'solanatracker.key'), `  ${KEY}\n`);
    assert.deepEqual(resolveTrackerKey({ env: {}, home }), { key: KEY, basis: '~/.dexterm/solanatracker.key' });
    assert.equal(resolveTrackerKey({ env: { DEXTERM_SOLANATRACKER_KEY: 'envkey_12345678' }, home })?.basis, 'env DEXTERM_SOLANATRACKER_KEY');
    writeFileSync(join(home, '.dexterm', 'solanatracker.key'), 'paste my key here please');
    assert.equal(resolveTrackerKey({ env: {}, home }), null, 'a sentence is not a key');
    assert.equal(resolveTrackerKey({ env: {}, home, readFile: () => { throw new Error('EACCES'); } }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('live transport: the key goes only as x-api-key, only to its own https host, and never follows a redirect', async () => {
  const seen: Array<{ url: string; headers: Record<string, string>; method: string; redirect?: string }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { method: string; headers: Record<string, string>; redirect?: string }) => {
    seen.push({ url, headers: init.headers, method: init.method, redirect: init.redirect });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const t = liveTransport();
    const host = 'data.solanatracker.io';
    await t({ method: 'GET', url: `https://${host}/tokens/abc`, apiKey: KEY, apiKeyHost: host });
    await t({ method: 'GET', url: 'https://api.dexscreener.com/x' });
    await assert.rejects(t({ method: 'GET', url: 'https://evil.example/tokens/abc', apiKey: KEY, apiKeyHost: host }), /keyed request refused/);
    await assert.rejects(t({ method: 'GET', url: `http://${host}/tokens/abc`, apiKey: KEY, apiKeyHost: host }), /keyed request refused/, 'no plain http');
    await assert.rejects(t({ method: 'POST', url: `https://${host}/x`, body: '{}', apiKey: KEY, apiKeyHost: host }), /keyed request refused/, 'no POST');
    await assert.rejects(t({ method: 'GET', url: `https://${host}/x`, apiKey: KEY }), /keyed request refused/, 'no host pin, no key');
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(seen.length, 2, 'refused requests never reach the network');
  assert.equal(seen[0].headers['x-api-key'], KEY);
  assert.equal(seen[0].redirect, 'error', 'a keyed request never follows a redirect');
  assert.ok(!seen[0].url.includes(KEY));
  assert.equal(seen[1].headers['x-api-key'], undefined, 'never on a keyless source');
  assert.equal(seen[1].redirect, 'follow');
});

test('adapter refuses a non-mint before spending a request', async () => {
  const calls: string[] = [];
  const clock = new FakeClock(0);
  const http = new HttpClient({ transport: async (req) => { calls.push(req.url); return json(200, SAMPLE); }, limiter: new RateLimiter(DEFAULT_BUCKETS, clock), health: new HealthRegistry({ clock, keys: { solanatracker: true } }), clock });
  await assert.rejects(new SolanaTracker(http, KEY).token('..'), /not a mint/);
  await assert.rejects(new SolanaTracker(http, KEY).token('abc/../x'), /not a mint/);
  assert.equal(calls.length, 0);
  assert.ok(!JSON.stringify(new SolanaTracker(http, KEY)).includes(KEY), 'the key is not serialisable');
});

test('adapter: the key reaches the transport but never a recording; the recorded URL is the bare endpoint', async () => {
  const clock = new FakeClock(0);
  const got: HttpRequest[] = [];
  const inner: Transport = async (req) => { got.push(req); return json(200, SAMPLE); };
  const store = new FixtureStore();
  const transport = recordingTransport(inner, store, { maxRequests: 10 });
  const http = new HttpClient({ transport, limiter: new RateLimiter(DEFAULT_BUCKETS, clock), health: new HealthRegistry({ clock, keys: { solanatracker: true } }), clock });
  const r = await new SolanaTracker(http, KEY).token(MINT);
  assert.equal(r.bundlerPct, 22);
  assert.equal(got[0].apiKey, KEY);
  assert.equal(got[0].apiKeyHost, 'data.solanatracker.io');
  assert.equal(got[0].url, `https://data.solanatracker.io/tokens/${MINT}`);
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-trk-rec-'));
  try {
    const path = join(dir, 'rec.json');
    store.save(path);
    assert.ok(!readFileSync(path, 'utf8').includes(KEY), 'the key is not in the saved recording');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('data layer: no key keeps the source needs-key and no adapter; a key turns it on', () => {
  const off = createDataLayer({ transport: async () => json(200, {}) });
  assert.equal(off.tracker, null);
  assert.equal(off.detail.hasTracker, false);
  assert.equal(off.health.get('solanatracker').state, 'needs-key');
  off.close();
  const on = createDataLayer({ transport: async () => json(200, {}), trackerKey: KEY });
  assert.ok(on.tracker);
  assert.equal(on.detail.hasTracker, true);
  assert.notEqual(on.health.get('solanatracker').state, 'needs-key');
  on.close();
});
