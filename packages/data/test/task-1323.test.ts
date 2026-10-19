// task-1323 item 2: request priority in the rate limiter. The cold-candle delay (12-17 s) was the
// GeckoTerminal bucket granting FIFO with a burst of 1: the chart the user just asked for queued behind
// the trades tape and the background prefetch, ~8.6 s per slot. These pin the fix: priority order,
// the foreground reserve, idle (hover) requests that never queue, and coalesced requests being raised —
// all without ever exceeding the 60 s window budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TokenBucket, RateLimiter, PriorityRef, RateDeferredError, DEFAULT_BUCKETS, FakeClock,
  HttpClient, HealthRegistry, withPriority, type Transport,
} from '../src/index.ts';

const GECKO = DEFAULT_BUCKETS.geckoterminal;

test('gecko bucket: same 7-per-minute budget, burst 2 with one slot reserved for foreground work', () => {
  const b = new TokenBucket('geckoterminal', GECKO, new FakeClock(0));
  assert.equal(GECKO.rpm, 10, 'documented keyless rpm unchanged');
  assert.equal(b.budget, 7, 'hard window budget unchanged (10 x 0.7)');
  assert.equal(b.capacity, 2);
  assert.equal(b.reserve, 1);
});

test('queue order is high > normal > low (FIFO within a class) while the bucket is parked', async () => {
  const clock = new FakeClock(0);
  const b = new TokenBucket('t', { rpm: 60, safety: 1, burst: 1 }, clock);
  await b.acquire(); // spend the only token: everything below queues
  const order: string[] = [];
  const q = (name: string, p: 'high' | 'normal' | 'low') => b.acquire(undefined, p).then(() => order.push(name));
  const all = [q('low1', 'low'), q('normal1', 'normal'), q('low2', 'low'), q('high1', 'high'), q('normal2', 'normal')];
  await clock.advance(5_000);
  await Promise.all(all);
  assert.deepEqual(order, ['high1', 'normal1', 'normal2', 'low1', 'low2']);
});

test('reserve: background (low) never takes the last token; a foreground request is granted at once', async () => {
  const clock = new FakeClock(0);
  const b = new TokenBucket('geckoterminal', GECKO, clock);
  await b.acquire(undefined, 'low'); // 2 tokens -> 1: allowed, the reserve is intact
  let lowGranted = false;
  const low = b.acquire(undefined, 'low').then(() => { lowGranted = true; });
  await clock.advance(0);
  assert.equal(lowGranted, false, 'a second low request would eat the reserve: it waits for a refill');
  let highGranted = false;
  const high = b.acquire(undefined, 'high').then(() => { highGranted = true; });
  await clock.advance(0);
  assert.equal(highGranted, true, 'the foreground request takes the reserved token immediately (no ~8.6 s wait)');
  assert.equal(lowGranted, false);
  // The low waiter needs tokens >= 2 again: two refills (~17.1 s) after the high grant.
  await clock.advance(8_000);
  assert.equal(lowGranted, false);
  await clock.advance(10_000);
  await Promise.all([low, high]);
  assert.equal(lowGranted, true, 'background work still flows, just behind the reserve');
});

test('a high arrival wakes a pump parked on a long low wait (no sleeping out the background wait)', async () => {
  const clock = new FakeClock(0);
  const b = new TokenBucket('geckoterminal', GECKO, clock);
  await b.acquire(undefined, 'high');
  await b.acquire(undefined, 'high'); // bucket empty
  let lowAt = -1, highAt = -1;
  void b.acquire(undefined, 'low').then(() => { lowAt = clock.now(); });
  await clock.advance(0); // pump parks for the low waiter (needs 2 tokens: ~17 s)
  void b.acquire(undefined, 'high').then(() => { highAt = clock.now(); });
  await clock.advance(9_000);
  assert.ok(highAt > 0 && highAt <= 8_600, `high granted at the first refill (${highAt} ms), not after the low wait`);
  assert.equal(lowAt, -1, 'low still waiting for its reserve-safe slot');
  await clock.advance(30_000);
  assert.ok(lowAt > highAt);
});

test('idle priority never queues: granted only on a full bucket, else RateDeferredError and nothing waits', async () => {
  const clock = new FakeClock(0);
  const b = new TokenBucket('geckoterminal', GECKO, clock);
  await b.acquire(undefined, 'idle'); // full bucket: ok
  await assert.rejects(b.acquire(undefined, 'idle'), (e: unknown) => e instanceof RateDeferredError);
  assert.equal(b.stats().queued, 0, 'the deferred idle request left nothing in the queue');
  assert.equal(b.tryAcquire('idle'), false);
  await clock.advance(8_600); // refilled to 2
  assert.equal(b.tryAcquire('idle'), true);
});

test('raising a queued request (coalesced foreground caller) moves it ahead of normal traffic', async () => {
  const clock = new FakeClock(0);
  const b = new TokenBucket('t', { rpm: 60, safety: 1, burst: 1 }, clock);
  await b.acquire();
  const ref = new PriorityRef('low');
  const order: string[] = [];
  void b.acquire(undefined, ref).then(() => order.push('raised'));
  void b.acquire(undefined, 'normal').then(() => order.push('normal'));
  await clock.advance(0);
  ref.raise('high');
  await clock.advance(5_000);
  assert.deepEqual(order, ['raised', 'normal']);
});

test('mixed priorities never exceed the 60 s window budget (randomised)', async () => {
  for (let seed = 1; seed <= 20; seed++) {
    const clock = new FakeClock(0);
    const b = new TokenBucket('geckoterminal', GECKO, clock);
    const grants: number[] = [];
    let x = seed;
    const rnd = () => { x = (x * 48271) % 2147483647; return x / 2147483647; };
    const levels = ['high', 'normal', 'low', 'idle'] as const;
    for (let i = 0; i < 60; i++) {
      const lv = levels[Math.floor(rnd() * 4)];
      b.acquire(undefined, lv).then(() => grants.push(clock.now()), () => {});
      await clock.advance(Math.floor(rnd() * 4_000));
    }
    await clock.advance(600_000);
    grants.sort((a, c) => a - c);
    let worst = 0;
    for (let i = 0; i < grants.length; i++) {
      let j = i;
      while (j < grants.length && grants[j] < grants[i] + 60_000) j++;
      worst = Math.max(worst, j - i);
    }
    assert.ok(worst <= b.budget, `seed ${seed}: ${worst} grants in 60 s > budget ${b.budget}`);
  }
});

test('HttpClient: a foreground caller coalescing onto a queued background GET raises it', async () => {
  const clock = new FakeClock(0);
  const limiter = new RateLimiter({ g: { rpm: 60, safety: 1, burst: 1 } }, clock);
  const sent: string[] = [];
  const transport: Transport = async (req) => { sent.push(new URL(req.url).pathname); return { status: 200, headers: {}, body: '{}', latencyMs: 1 }; };
  const http = new HttpClient({ transport, limiter, health: new HealthRegistry({ clock }), clock });
  const meta = { source: 'geckoterminal' as const, bucket: 'g' };
  await http.getJson('https://x.test/first', meta); // spends the token
  const bg = withPriority('low', () => http.getJson('https://x.test/candles', meta));
  const other = http.getJson('https://x.test/other', meta); // normal, queued after the low one
  await clock.advance(0);
  const fg = withPriority('high', () => http.getJson('https://x.test/candles', meta)); // same URL: coalesces
  await clock.advance(5_000);
  await Promise.all([bg, other, fg]);
  assert.deepEqual(sent, ['/first', '/candles', '/other'], 'the coalesced request was raised past the normal one');
});
