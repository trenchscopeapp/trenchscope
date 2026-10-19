// Tier 5 — backtest harness over a recorder export doc. Offline, pure, no DB, no model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExportDoc, ExportRecord, Label } from '@dexterm/recorder';
import { runBacktest, aucByRank } from '../src/backtest.ts';
import { h1Model } from '../src/rug-model.ts';

let seq = 0;
function rec(feats: Record<string, string | number | null>, label: Label, opts: { feeds?: string[]; positive?: boolean; max_mcap_ratio?: number | null; mcap_ratio?: number | null } = {}): ExportRecord {
  const positive = opts.positive ?? (label === 'rug' || label === 'dead');
  return {
    mint: `mint-${seq++}`, t0: 1_700_000_000_000 + seq * 1000, known_sec: 0, feeds: opts.feeds ?? [],
    features: { symbol: `T${seq}`, ...feats },
    outcomes: { '3600': { label, tier: 'keyless-proxy', t1: 1, mcap_ratio: opts.mcap_ratio ?? 1, liq_ratio: 1, price_ratio: 1, max_mcap_ratio: opts.max_mcap_ratio ?? 1, positive } },
  };
}

function doc(records: ExportRecord[]): ExportDoc {
  return {
    schema: 'dexterm-recorder-export/1', exported_at: '2026-10-11T00:00:00Z', labeler_version: '0.2.0',
    data_tier: 'keyless-proxy', leakage_rule: 'x', horizons_sec: [3600, 7200, 21600, 86400, 259200],
    counts: { records: records.length, with_any_outcome: records.length, by_label: {} }, records,
  };
}

test('aucByRank is 1 for a perfect separator, 0.5 for a constant, null for one class', () => {
  assert.equal(aucByRank([{ p: 0.9, y: 1 }, { p: 0.1, y: 0 }]), 1);
  assert.equal(aucByRank([{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }]), 0.5);
  assert.equal(aucByRank([{ p: 0.9, y: 1 }, { p: 0.8, y: 1 }]), null);
});

test('heuristic subject: H1 flags thin fresh pools, misses established tokens → precision/recall/confusion', () => {
  // Two clear positives (thin fresh, no pool): H1 scores them >= 0.5. Two clear negatives (established).
  const d = doc([
    rec({ liquidity_usd: 500, mcap: 20000, age_sec: 120, src_market: 'jupiter-tokens', holder_count: 10 }, 'dead'),
    rec({ liquidity_usd: 800, mcap: 15000, age_sec: 300, src_market: 'jupiter-tokens', holder_count: 20 }, 'rug'),
    rec({ liquidity_usd: 300000, mcap: 10_000_000, age_sec: 30 * 86400, src_market: 'dexscreener', holder_count: 8000, organic_score: 85 }, 'flat'),
    rec({ liquidity_usd: 250000, mcap: 8_000_000, age_sec: 20 * 86400, src_market: 'dexscreener', holder_count: 6000, organic_score: 80 }, 'runner', { max_mcap_ratio: 3 }),
  ]);
  const r = runBacktest(d, { kind: 'heuristic', horizon_sec: 3600, subject: { model: h1Model() } });
  assert.equal(r.n, 4);
  assert.equal(r.base_rate, 0.5);
  assert.equal(r.tp, 2, 'both thin fresh positives flagged');
  assert.equal(r.fp, 0, 'established tokens not flagged');
  assert.equal(r.precision, 1);
  assert.equal(r.recall, 1);
  assert.equal(r.auc, 1);
  assert.ok((r.brier ?? 1) < (r.brier_base_rate ?? 0), 'model Brier beats the base-rate Brier here');
  assert.ok(r.calibration && r.calibration.length === 5);
  assert.deepEqual(r.leakage_checks, { features_from_t0_only: true, labels_after_t0: true, no_future_feeds: true });
});

test('heuristic subject: per-feed breakdown is present and splits positives by feed', () => {
  const d = doc([
    rec({ liquidity_usd: 500, mcap: 20000, age_sec: 120, src_market: 'jupiter-tokens' }, 'dead', { feeds: ['jup:recent'] }),
    rec({ liquidity_usd: 300000, mcap: 10_000_000, age_sec: 30 * 86400, src_market: 'dexscreener', holder_count: 8000 }, 'flat', { feeds: ['jup:trending-1h'] }),
  ]);
  const r = runBacktest(d, { kind: 'heuristic', horizon_sec: 3600, subject: { model: h1Model() } });
  assert.ok(r.by_feed && r.by_feed['jup:recent']);
  assert.equal(r.by_feed!['jup:recent'].pos, 1);
  assert.equal(r.by_feed!['jup:trending-1h'].pos, 0);
});

test('worst misses and false alarms carry the t0 numbers', () => {
  const d = doc([
    // a positive H1 misses (established-looking but actually dead): give it established credits
    rec({ liquidity_usd: 200000, mcap: 9_000_000, age_sec: 40 * 86400, src_market: 'dexscreener', holder_count: 9000, organic_score: 90 }, 'dead'),
    // a negative H1 flags (thin fresh but flat)
    rec({ liquidity_usd: 400, mcap: 10000, age_sec: 100, src_market: 'jupiter-tokens' }, 'flat'),
  ]);
  const r = runBacktest(d, { kind: 'heuristic', horizon_sec: 3600, subject: { model: h1Model() } });
  assert.equal(r.worst_misses?.length, 1);
  assert.equal(r.worst_misses![0].label, 'dead');
  assert.ok(typeof r.worst_misses![0].liq === 'number');
  assert.equal(r.worst_false_alarms?.length, 1);
  assert.equal(r.worst_false_alarms![0].label, 'flat');
});

test('filter subject: runner rate for the matched set vs the base rate, median mcap ratio', () => {
  const d = doc([
    rec({ liquidity_usd: 120000, organic_score: 80, age_sec: 3600 }, 'runner', { max_mcap_ratio: 4, mcap_ratio: 4 }),
    rec({ liquidity_usd: 150000, organic_score: 85, age_sec: 7200 }, 'runner', { max_mcap_ratio: 3, mcap_ratio: 3 }),
    rec({ liquidity_usd: 2000, organic_score: 20, age_sec: 60 }, 'dead', { mcap_ratio: 0.1 }),
    rec({ liquidity_usd: 1000, organic_score: 10, age_sec: 30 }, 'dead', { mcap_ratio: 0.05 }),
  ]);
  // filter: "liq >= 100K org >= 60" matches the two runners only
  const pred = (f: ExportRecord['features']) => Number(f.liquidity_usd ?? 0) >= 100000 && Number(f.organic_score ?? 0) >= 60;
  const r = runBacktest(d, { kind: 'filter', horizon_sec: 3600, subject: { filter: pred, filter_text: 'liq >= 100K org >= 60' } });
  assert.equal(r.n, 4);
  assert.equal(r.matched, 2);
  assert.equal(r.runner_rate, 1, 'every matched token was a runner');
  assert.equal(r.runner_rate_base, 0.5, 'half the universe were runners');
  assert.equal(r.median_mcap_ratio, 3.5);
  assert.ok(r.note?.includes('liq >= 100K'));
});

test('pack_verdicts subject reads a recorded rug_p lookup; rows with no verdict are skipped', () => {
  const d = doc([
    rec({ liquidity_usd: 500, src_market: 'jupiter-tokens' }, 'dead'),
    rec({ liquidity_usd: 300000, src_market: 'dexscreener', holder_count: 8000 }, 'flat'),
  ]);
  const verdictRugP = (mint: string) => (mint === d.records[0].mint ? 0.9 : mint === d.records[1].mint ? 0.1 : null);
  const r = runBacktest(d, { kind: 'pack_verdicts', horizon_sec: 3600, subject: { verdictRugP } });
  assert.equal(r.n, 2);
  assert.equal(r.auc, 1);
});

test('unobserved outcomes and missing horizons are excluded', () => {
  const r0 = rec({ liquidity_usd: 500, src_market: 'jupiter-tokens' }, 'unobserved', { positive: false });
  const r1 = rec({ liquidity_usd: 300000, src_market: 'dexscreener', holder_count: 8000 }, 'flat');
  const d = doc([r0, r1]);
  const r = runBacktest(d, { kind: 'heuristic', horizon_sec: 3600, subject: { model: h1Model() } });
  assert.equal(r.n, 1, 'the unobserved row is not scored');
});

test('strategy and watch_rule subjects return a stable not-implemented shape (no throw)', () => {
  const d = doc([rec({ liquidity_usd: 500, src_market: 'jupiter-tokens' }, 'dead')]);
  const s = runBacktest(d, { kind: 'strategy', horizon_sec: 3600, subject: {} });
  assert.ok(s.note?.includes('not implemented'));
  assert.equal(s.precision, null);
  const w = runBacktest(d, { kind: 'watch_rule', horizon_sec: 3600, subject: {} });
  assert.ok(w.note?.includes('not implemented'));
});
