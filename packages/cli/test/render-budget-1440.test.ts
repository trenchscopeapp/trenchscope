import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFrameBudget } from './perf/budget.ts';

test('Windows quantized CPU counter cannot invent a 16 ms frame; wall upper bound stays strict', () => {
  // Native hosted evidence: 16 ms CPU-accounting ticks for 2.44 ms wall p95.
  assertFrameBudget('fixture', { p95: 2.44, cpuP95: 16 }, 'quantized counter', 'win32');
  for (const p95 of [16, 17, 100]) {
    // Even a zero/lagging CPU counter cannot excuse a missed frame deadline.
    assert.throws(() => assertFrameBudget('fixture', { p95, cpuP95: 0 }, '', 'win32'), /must be under 16 ms/);
  }
});

test('high-resolution CPU guard and unconditional wall guard remain mandatory on POSIX', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    assert.throws(() => assertFrameBudget('fixture', { p95: 2, cpuP95: 16 }, '', platform), /CPU p95/);
    assert.throws(() => assertFrameBudget('fixture', { p95: 16, cpuP95: 2 }, '', platform), /wall p95/);
    assertFrameBudget('fixture', { p95: 3, cpuP95: 2 }, '', platform);
  }
});
