import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeClock } from '../src/clock.ts';
import { DEFAULT_BUCKETS, RateLimiter, TokenBucket, WINDOW_MS } from '../src/limiter.ts';
import { maxInWindow, mulberry32 } from './helpers.ts';

const SOAK_MS = 5 * 60_000;

/** Drive a bucket for 5 fake minutes with the given arrival times; return grant times and order. */
async function soak(bucket: TokenBucket, clock: FakeClock, arrivals: number[], hooks: { at?: (t: number) => void } = {}) {
  const grants: number[] = [];
  const order: number[] = [];
  bucket.onGrant = (t) => grants.push(t);
  const sorted = [...arrivals].sort((a, b) => a - b);
  const start = clock.now();
  let i = 0;
  for (let t = 0; t < SOAK_MS; t += 250) {
    while (i < sorted.length && sorted[i] <= t) {
      const id = i++;
      void bucket.acquire().then(() => order.push(id));
    }
    hooks.at?.(t);
    await clock.advance(250);
  }
  return { grants: grants.map((g) => g - start), order, issued: i };
}

test('token bucket: tryAcquire honours burst then refuses until refill', () => {
  const clock = new FakeClock(0);
  const b = new TokenBucket('t', { rpm: 60, safety: 1, burst: 3 }, clock);
  assert.equal(b.budget, 60);
  assert.equal(b.tryAcquire(), true);
  assert.equal(b.tryAcquire(), true);
  assert.equal(b.tryAcquire(), true);
  assert.equal(b.tryAcquire(), false);
  assert.equal(b.delay(clock.now()), 1000); // 60/min refill = 1 per second
});

test('soak (property): random configs and arrival patterns never exceed budget in any 60 s window over 5 fake minutes', async () => {
  for (let seed = 1; seed <= 16; seed++) {
    const rng = mulberry32(seed);
    const rpm = [300, 60, 30, 10][Math.floor(rng() * 4)];
    const safety = 0.5 + rng() * 0.5;
    const budget = Math.max(1, Math.floor(rpm * safety));
    const burst = 1 + Math.floor(rng() * budget); // anything from 1 to the whole budget
    const clock = new FakeClock(0);
    const bucket = new TokenBucket(`seed${seed}`, { rpm, safety, burst }, clock);

    // Demand 1.5x to 3x the budget: mix of uniform arrivals and bursts.
    const demand = Math.ceil(budget * 5 * (1.5 + rng() * 1.5));
    const arrivals: number[] = [];
    while (arrivals.length < demand) {
      const t = Math.floor(rng() * SOAK_MS);
      const k = rng() < 0.3 ? 1 + Math.floor(rng() * budget) : 1;
      for (let j = 0; j < k && arrivals.length < demand; j++) arrivals.push(t);
    }
    // Random 429-style pauses must not break the invariant either.
    const pauses = new Set(Array.from({ length: 3 }, () => Math.floor((rng() * SOAK_MS) / 250) * 250));
    const { grants, order } = await soak(bucket, clock, arrivals, { at: (t) => pauses.has(t) && bucket.pause(5_000 + rng() * 20_000) });

    const worst = maxInWindow(grants, WINDOW_MS);
    assert.ok(worst <= budget, `seed ${seed}: ${worst} grants in a 60 s window > budget ${budget} (rpm ${rpm}, safety ${safety.toFixed(2)}, burst ${burst})`);
    assert.ok(worst <= rpm, `seed ${seed}: exceeded documented rpm`);
    // Saturated demand keeps the bucket busy: at least ~3.5 windows' worth of budget in 5 minutes despite pauses.
    assert.ok(grants.length >= Math.floor(budget * 3.5), `seed ${seed}: starved (${grants.length} grants, budget ${budget})`);
    // FIFO: grants happen in arrival order.
    for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1], `seed ${seed}: out-of-order grant`);
  }
});

test('soak: every default bucket stays within its documented limit for 5 minutes of saturating demand', async () => {
  for (const [name, cfg] of Object.entries(DEFAULT_BUCKETS)) {
    const clock = new FakeClock(0);
    const limiter = new RateLimiter({ [name]: cfg }, clock);
    const bucket = limiter.bucket(name);
    const arrivals = Array.from({ length: cfg.rpm * 6 }, (_, i) => Math.floor((i / (cfg.rpm * 6)) * SOAK_MS));
    const { grants } = await soak(bucket, clock, arrivals);
    const per60 = maxInWindow(grants, 60_000);
    assert.ok(per60 <= bucket.budget, `${name}: ${per60} in 60 s > budget ${bucket.budget}`);
    assert.ok(per60 <= Math.floor(cfg.rpm * 0.7), `${name}: above 0.7 x documented ${cfg.rpm} rpm`);
    if (name === 'jupiter') {
      // Observed 2026-10-05: Jupiter keyless enforces 5 requests per short window.
      const per10 = maxInWindow(grants, 10_000);
      assert.ok(per10 <= 4, `jupiter: ${per10} requests in 10 s (observed limit 5)`);
    }
    // Throughput: within 10 % of the budget per minute once the burst is spent.
    assert.ok(grants.length >= bucket.budget * 4.5, `${name}: only ${grants.length} grants in 5 min (budget ${bucket.budget}/min)`);
  }
});

test('pause() holds the queue until the pause ends, then resumes in order', async () => {
  const clock = new FakeClock(0);
  const b = new TokenBucket('p', { rpm: 600, safety: 1, burst: 10 }, clock);
  const got: number[] = [];
  b.pause(30_000);
  for (let i = 0; i < 3; i++) void b.acquire().then(() => got.push(clock.now()));
  await clock.advance(29_999);
  assert.deepEqual(got, []);
  await clock.advance(1);
  assert.deepEqual(got, [30_000, 30_000, 30_000]);
});

test('acquire() can be aborted while queued and frees its slot', async () => {
  const clock = new FakeClock(0);
  const b = new TokenBucket('a', { rpm: 60, safety: 1, burst: 1 }, clock);
  await b.acquire();
  const ac = new AbortController();
  const aborted = b.acquire(ac.signal);
  let second = false;
  void b.acquire().then(() => (second = true));
  ac.abort();
  await assert.rejects(aborted, { name: 'AbortError' });
  await clock.advance(1_000);
  assert.equal(second, true, 'the next waiter takes the freed slot');
  assert.equal(b.stats().queued, 0);
});

test('stats() reports usage in the current window', async () => {
  const clock = new FakeClock(0);
  const limiter = new RateLimiter({ x: { rpm: 100, safety: 1, burst: 5 } }, clock);
  for (let i = 0; i < 5; i++) await limiter.acquire('x');
  assert.equal(limiter.stats()[0].rpmUsed, 5);
  await clock.advance(60_000);
  assert.equal(limiter.stats()[0].rpmUsed, 0);
  assert.throws(() => limiter.bucket('nope'), /unknown rate-limit bucket/);
});

test('close() wakes a parked rate wait and rejects queued acquires (task-1319 quit hang)', async () => {
  const clock = new FakeClock(0);
  // burst 1: the first acquire grants now, the second must wait for a refill, so pump() parks in a
  // clock.sleep. Before task-1319 that sleep was ref'd and uncancellable, so a quit waited it out.
  const b = new TokenBucket('q', { rpm: 60, safety: 1, burst: 1 }, clock);
  await b.acquire();
  let rejected = false;
  const p = b.acquire().catch((e: Error) => { rejected = e.name === 'AbortError'; });
  await clock.advance(0); // let pump() enter its sleep
  assert.ok(clock.pendingTimers >= 1, 'the pump is parked in a rate-limit sleep');
  b.close();
  await p;
  assert.ok(rejected, 'the queued acquire rejected on close');
  assert.equal(clock.pendingTimers, 0, 'close() cancelled the parked sleep so a quit does not wait it out');
  await assert.rejects(b.acquire(), /aborted/, 'acquires after close reject immediately');
});

test('RateLimiter.close() closes every bucket', async () => {
  const clock = new FakeClock(0);
  const limiter = new RateLimiter({ a: { rpm: 60, safety: 1, burst: 1 }, b: { rpm: 60, safety: 1, burst: 1 } }, clock);
  await limiter.acquire('a');
  const p = limiter.acquire('a').catch((e: Error) => e.name);
  await clock.advance(0);
  limiter.close();
  assert.equal(await p, 'AbortError', 'a queued acquire on a closed limiter rejects');
  assert.equal(clock.pendingTimers, 0, 'no limiter sleep survives close across buckets');
});
