import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runSelfTest, renderSelfTest, fixtureChartVM } from '../src/selftest.ts';

test('fixtureChartVM: deterministic, network-free candle series', () => {
  const a = fixtureChartVM(); const b = fixtureChartVM();
  assert.equal(a.candles.length, 120);
  assert.equal(a.symbol, 'SELFTEST');
  assert.deepEqual(a.candles.map((c) => c.o), b.candles.map((c) => c.o), 'deterministic series');
  assert.ok(a.candles.every((c) => c.h >= c.l && c.o > 0 && c.c > 0));
});

test('runSelfTest: browser fallback path reports shell=browser, no fps, and labels what needs a human', async () => {
  const r = await runSelfTest({ forceBrowser: true, platform: 'linux', seconds: 2, env: { DEXTERM_HOME: '/tmp/dexterm-selftest-none' } as NodeJS.ProcessEnv });
  assert.equal(r.shell, 'browser');
  assert.equal(r.fps, null);
  assert.ok(r.needsHuman.length > 0);
  assert.ok(r.needsHuman.some((h) => /build:shell|browser fallback/i.test(h)));
  const text = renderSelfTest(r, false);
  assert.match(text, /self-test/);
  assert.match(text, /window shell/);
  assert.match(text, /browser fallback/);
});
