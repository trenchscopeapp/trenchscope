// task-1314: local candle derivation. The coarser timeframes aggregate exactly from a finer base,
// so a timeframe switch paints instantly from two network fetches (1m, 1h) instead of one per tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCandles, CANDLE_BASE, CANDLE_BASE_INTERVALS } from '../src/candles.ts';
import { CANDLE_TIMEFRAMES } from '../src/sources/geckoterminal.ts';
import type { Candle } from '../src/model.ts';

const MIN = 60_000;

/** `n` one-minute bars starting at a UTC-aligned minute; close = open+1 so order is checkable. */
function oneMinSeries(startMs: number, n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const o = 100 + i;
    out.push({ t: startMs + i * MIN, o, h: o + 2, l: o - 1, c: o + 1, v: 10 });
  }
  return out;
}

test('aggregateCandles: 5m bucket is OHLCV-correct (open first, close last, high/low extremes, volume sum)', () => {
  const start = Date.UTC(2026, 0, 1, 0, 0, 0); // UTC-aligned minute
  const base = oneMinSeries(start, 10);         // two full 5m buckets
  const five = aggregateCandles(base, MIN, 5 * MIN);
  assert.equal(five.length, 2);
  // first 5m bar = minutes 0..4
  assert.equal(five[0].t, start);
  assert.equal(five[0].o, base[0].o, 'open = first sub-bar open');
  assert.equal(five[0].c, base[4].c, 'close = last sub-bar close');
  assert.equal(five[0].h, Math.max(...base.slice(0, 5).map((b) => b.h)));
  assert.equal(five[0].l, Math.min(...base.slice(0, 5).map((b) => b.l)));
  assert.equal(five[0].v, base.slice(0, 5).reduce((a, b) => a + b.v, 0));
  assert.equal(five[1].t, start + 5 * MIN);
});

test('aggregateCandles: buckets align to the UTC period boundary even with a ragged start', () => {
  const start = Date.UTC(2026, 0, 1, 0, 2, 0); // starts at minute :02, mid-bucket
  const base = oneMinSeries(start, 8);          // minutes :02.. :09
  const five = aggregateCandles(base, MIN, 5 * MIN);
  // first bucket floors to :00 (covers :02..:04), second is :05..:09
  assert.equal(five[0].t, Date.UTC(2026, 0, 1, 0, 0, 0));
  assert.equal(five[0].v, 30, 'three 1m bars (:02,:03,:04) in the first bucket');
  assert.equal(five[1].t, Date.UTC(2026, 0, 1, 0, 5, 0));
  assert.equal(five[1].v, 50, 'five 1m bars in the second bucket');
});

test('aggregateCandles: gaps (missing sub-bars) stay gaps, never invented', () => {
  const start = Date.UTC(2026, 0, 1, 0, 0, 0);
  const base = oneMinSeries(start, 20).filter((b) => (b.t - start) / MIN < 5 || (b.t - start) / MIN >= 15); // drop the middle 10m
  const five = aggregateCandles(base, MIN, 5 * MIN);
  const ts = five.map((b) => (b.t - start) / (5 * MIN));
  assert.deepEqual(ts, [0, 3], 'buckets 1 and 2 are absent because no sub-bars fell in them');
});

test('aggregateCandles: refuses non-integer multiples and empty input (caller fetches natively)', () => {
  const base = oneMinSeries(Date.UTC(2026, 0, 1), 10);
  assert.deepEqual(aggregateCandles(base, 2 * MIN, 5 * MIN), [], '5m is not an integer multiple of 2m');
  assert.deepEqual(aggregateCandles(base, 5 * MIN, MIN), [], 'target coarser than base required');
  assert.deepEqual(aggregateCandles([], MIN, 5 * MIN), []);
});

test('derivation map: every non-base tab derives from a base that divides it evenly', () => {
  assert.deepEqual(CANDLE_BASE_INTERVALS, ['1m', '1h']);
  for (const [iv, base] of Object.entries(CANDLE_BASE)) {
    const to = CANDLE_TIMEFRAMES[iv as keyof typeof CANDLE_TIMEFRAMES].periodMs;
    const from = CANDLE_TIMEFRAMES[base as keyof typeof CANDLE_TIMEFRAMES].periodMs;
    assert.equal(to % from, 0, `${iv} must be an integer multiple of ${base}`);
    assert.ok(CANDLE_BASE_INTERVALS.includes(base), `${iv} derives from a base interval`);
  }
});

test('aggregateCandles: unsorted base is handled (sorted before bucketing)', () => {
  const start = Date.UTC(2026, 0, 1, 0, 0, 0);
  const base = oneMinSeries(start, 5).reverse();
  const five = aggregateCandles(base, MIN, 5 * MIN);
  assert.equal(five.length, 1);
  assert.equal(five[0].o, 100, 'open is the earliest minute even though input was newest-first');
  assert.equal(five[0].c, 105);
});
