import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeClock, flushMicrotasks } from '../src/clock.ts';
import { FixtureMissError, FixtureStore, recordingTransport, replayTransport } from '../src/fixtures.ts';
import { HealthRegistry } from '../src/health.ts';
import { HttpClient, HttpError, SourceUnavailableError, liveTransport } from '../src/http.ts';
import type { HttpRequest, Transport } from '../src/http.ts';
import { RateLimiter } from '../src/limiter.ts';
import { NetworkBlockedError, json, loadSample, sampleClock, spy } from './helpers.ts';

const META = { source: 'dexscreener', bucket: 'b' } as const;

function client(transport: Transport, clock = new FakeClock(0)) {
  const limiter = new RateLimiter({ b: { rpm: 6000, safety: 1, burst: 100 } }, clock);
  const health = new HealthRegistry({ clock });
  return { http: new HttpClient({ transport, limiter, health, clock }), limiter, health, clock };
}

test('tests cannot reach the network: live transport fails on the blocked fetch', async () => {
  await assert.rejects(liveTransport()({ method: 'GET', url: 'https://api.dexscreener.com/token-boosts/top/v1' }), NetworkBlockedError);
});

test('replayer serves recorded responses and throws on a miss', async () => {
  const store = loadSample();
  assert.ok(store.size >= 10);
  const replay = replayTransport(store);
  const r = await replay({ method: 'GET', url: 'https://api.dexscreener.com/token-boosts/top/v1' });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(JSON.parse(r.body)));
  await assert.rejects(replay({ method: 'GET', url: 'https://api.dexscreener.com/nope' }), FixtureMissError);
});

test('recorder captures through an inner transport, enforces its budget, and round-trips to disk', async () => {
  let n = 0;
  const fakeLive: Transport = async (req: HttpRequest) => json(200, { n: ++n, url: req.url }, { 'x-ratelimit-remaining': '9' });
  const store = new FixtureStore();
  const rec = recordingTransport(fakeLive, store, { maxRequests: 2 });
  await rec({ method: 'GET', url: 'https://example.test/a?x=1,2' });
  await rec({ method: 'GET', url: 'https://example.test/b' });
  await assert.rejects(rec({ method: 'GET', url: 'https://example.test/c' }), /budget exhausted/);
  assert.equal(rec.count(), 2);
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-fx-'));
  try {
    const path = join(dir, 'f.json');
    store.save(path, 'unit');
    const loaded = FixtureStore.load(path);
    assert.equal(loaded.note, 'unit');
    const r = await replayTransport(loaded)({ method: 'GET', url: 'https://example.test/a?x=1,2' });
    assert.deepEqual(JSON.parse(r.body), { n: 1, url: 'https://example.test/a?x=1,2' });
    assert.equal(r.headers['x-ratelimit-remaining'], '9');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('http client: identical in-flight GETs are coalesced into one request', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const t = spy(async () => {
    await gate;
    return json(200, { ok: 1 });
  });
  const { http } = client(t);
  const a = http.getJson('https://x.test/a', META);
  const b = http.getJson('https://x.test/a', META);
  await flushMicrotasks();
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(t.calls.length, 1);
  assert.deepEqual(ra.data, rb.data);
});

test('http client: recorded Jupiter 429 pauses the bucket and counts toward health', async () => {
  const store = loadSample();
  const clock = sampleClock(store);
  const limiter = new RateLimiter({ jupiter: { rpm: 30, burst: 1 } }, clock);
  const health = new HealthRegistry({ clock });
  const http = new HttpClient({ transport: replayTransport(store), limiter, health, clock });
  const meta = { source: 'jupiter-tokens', bucket: 'jupiter' } as const;
  const url = 'https://api.jup.ag/tokens/v2/search?query=BONK';
  await assert.rejects(http.getJson(url, meta), (e: unknown) => e instanceof HttpError && e.status === 429);
  // task-1368: the server's own x-ratelimit-reset (no Retry-After on Jupiter's 429) governs the FIRST strike's pause,
  // capped at 60 s; the 30 s default applies only when the 429 carries no hint at all (next test).
  const paused = limiter.bucket('jupiter').stats().pausedUntil - clock.now();
  assert.ok(paused > 0 && paused <= 60_000, `first-strike pause follows the advertised reset (${paused} ms)`);
  assert.equal(health.get('jupiter-tokens').consecutiveFailures, 1);
  // A second 429 inside a minute demotes the source; further calls short-circuit without a request.
  await clock.advance(31_000);
  await assert.rejects(http.getJson(url, meta), (e: unknown) => e instanceof HttpError && e.status === 429);
  assert.equal(health.state('jupiter-tokens'), 'degraded');
  await assert.rejects(http.getJson(url, meta), SourceUnavailableError);
});

test('http client: a 429 with no Retry-After and no reset hint pauses the default 30 s; a second strike doubles', async () => {
  const clock = new FakeClock(1_000_000_000_000);
  const { http, limiter } = client(async () => json(429, { error: 'slow down' }), clock);
  await assert.rejects(http.getJson('https://x.test/a', META), (e: unknown) => e instanceof HttpError && e.status === 429);
  assert.equal(limiter.bucket('b').stats().pausedUntil, clock.now() + 30_000, 'default 30 s pause without any server hint');
  await clock.advance(31_000);
  await assert.rejects(http.getJson('https://x.test/a', META), (e: unknown) => e instanceof HttpError && e.status === 429);
  assert.equal(limiter.bucket('b').stats().pausedUntil, clock.now() + 60_000, 'second consecutive strike doubles');
});

test('http client: x-ratelimit-remaining 0 pauses until the advertised reset', async () => {
  const clock = new FakeClock(1_000_000_000_000);
  const resetSec = (clock.now() + 7_000) / 1000;
  const { http, limiter } = client(async () => json(200, [], { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSec) }), clock);
  await http.getJson('https://x.test/z', META);
  assert.equal(limiter.bucket('b').stats().pausedUntil, clock.now() + 7_000);
});

test('http client: non-2xx, bad JSON and transport errors are failures; 3 in a row degrade', async () => {
  const responses = [json(500, {}), { status: 200, headers: {}, body: '<html>', latencyMs: 3 }];
  const t: Transport = async () => {
    const r = responses.shift();
    if (!r) throw new Error('ECONNRESET');
    return r;
  };
  const { http, health } = client(t);
  await assert.rejects(http.getJson('https://x.test/1', META), /HTTP 500/);
  await assert.rejects(http.getJson('https://x.test/2', META), /invalid JSON/);
  await assert.rejects(http.getJson('https://x.test/3', META), /ECONNRESET/);
  assert.equal(health.state('dexscreener'), 'degraded');
  assert.equal(health.get('dexscreener').lastError, 'ECONNRESET');
});
