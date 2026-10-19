// task-1366 — market-cap formatter units: K/M/B/T, three significant digits, rounding across a unit, tiny and huge values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtMcap, fmtMcapBare } from '../src/fmt.ts';

test('fmtMcapBare: K / M / B / T with at most three significant digits', () => {
  const cases: Array<[number, string]> = [
    [300_000, '300K'], [1_200_000, '1.2M'], [1_234_567, '1.23M'], [12_345_678, '12.3M'], [123_456_789, '123M'],
    [1_200_000_000, '1.2B'], [4_500, '4.5K'], [45_000, '45K'], [950, '950'], [1, '1'], [12.34, '12.3'],
    [2.5e12, '2.5T'], [3.2e15, '3200T'],
  ];
  for (const [n, want] of cases) assert.equal(fmtMcapBare(n), want, String(n));
});

test('fmtMcapBare: rounding never prints 1000K / 1000M', () => {
  assert.equal(fmtMcapBare(999_999), '1M');
  assert.equal(fmtMcapBare(999_499), '999K');
  assert.equal(fmtMcapBare(999_999_999), '1B');
  assert.equal(fmtMcapBare(999.9), '1K');
});

test('fmtMcapBare: tiny, zero, negative and non-finite values', () => {
  assert.equal(fmtMcapBare(0), '0');
  assert.equal(fmtMcapBare(0.42), '0.42');
  assert.equal(fmtMcapBare(0.0001234), '0.00012');
  assert.equal(fmtMcapBare(-1_500_000), '-1.5M');
  assert.equal(fmtMcapBare(null), '—');
  assert.equal(fmtMcapBare(undefined), '—');
  assert.equal(fmtMcapBare(Number.NaN), '—');
  assert.equal(fmtMcapBare(Number.POSITIVE_INFINITY), '—');
});

test('fmtMcap prefixes $ (and keeps the sign outside it)', () => {
  assert.equal(fmtMcap(300_000), '$300K');
  assert.equal(fmtMcap(1_234_567), '$1.23M');
  assert.equal(fmtMcap(-2e9), '-$2B');
  assert.equal(fmtMcap(null), '—');
});
