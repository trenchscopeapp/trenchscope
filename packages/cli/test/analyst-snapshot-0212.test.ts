// 2026-10-12: every analyst turn carries a LIVE SNAPSHOT of the selected coin (price, moves, holders, history).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analystContextBlock, selectedSnapshotLines } from '../src/analyst/backend.ts';

const base = { source: 'token-screen', mint: 'M1', symbol: 'BONK', priceUsd: 0.0000377, chg: { m5: 1, h1: -2, h6: 3, h24: 10 }, mcap: 3_300_000, fdv: 3_300_000,
  liq: 423_751, vol24: 1_200_000, holders: 1_026_318, holdersChgPct24h: 0.4, top10Pct: 36, ageMin: 5000, interval: '1h', spark: null, asOf: Date.parse('2026-10-12T21:00:00Z') };

test('snapshot: price, moves, TOTAL holder count and a candle history summary are all in the turn context', () => {
  const candles = Array.from({ length: 24 }, (_, i) => [Date.parse('2026-10-12T00:00:00Z') + i * 3_600_000, 1 + i / 100, 1.5 + i / 100, 0.9, 1 + (i + 1) / 100, 10]);
  const out = selectedSnapshotLines({ ...base, candles }).join('\n');
  assert.match(out, /price \$0\.00003770/);
  assert.match(out, /24h \+10\.0%/);
  assert.match(out, /holders 1,026,318 TOTAL/);
  assert.match(out, /HISTORY \(1h candles, 24 bars/);
  assert.match(out, /top-20 SAMPLE/);
});

test('snapshot: a row without candles says so and sends the model to get_dossier instead of guessing history', () => {
  const out = selectedSnapshotLines({ ...base, source: 'screener-row', candles: null, interval: null, spark: [1, 2, 3] }).join('\n');
  assert.match(out, /sparkline/);
  assert.match(out, /get_dossier/);
});

test('snapshot: unknown holders read "unknown", never 0 or 20; no selection renders nothing', () => {
  const out = selectedSnapshotLines({ ...base, holders: null, candles: null, spark: null }).join('\n');
  assert.match(out, /holders unknown/);
  assert.deepEqual(selectedSnapshotLines(null), []);
});

test('snapshot is part of analystContextBlock', () => {
  const b = analystContextBlock({ screen: 'screener', selected: { mint: 'M1', symbol: 'BONK' }, selectedDetail: { ...base, candles: null, spark: [1, 2] } });
  assert.match(b, /LIVE SNAPSHOT of the selected coin/);
});
