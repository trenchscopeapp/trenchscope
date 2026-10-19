// Backtest harness (AI-SUITE-DESIGN §6, lane B-01). Scores a subject over recorder history and reports
// HONEST metrics. One join, four subjects; this tier ships the first three (the `strategy`/paper subject
// waits on the position-fill simulator, §6, and is left as a typed `not_implemented` result so the shape
// is stable). It is a pure function of a recorder export doc (export.ts), so every test is offline on a
// fixture and the numbers are re-runnable from history.sqlite.
//
// Subjects:
//   heuristic   score an in-code model (H1 / a logistic model) → precision/recall/Brier/AUC/calibration.
//   filter      a dexterm-grammar filter (parsed by the CALLER into a predicate; this module never
//               eval's a string) → label distribution, runner rate vs base rate, median mcap ratio.
//   pack_verdicts the recorded `rug_p` of a pack's reason stage → same metrics as heuristic (so the eval
//               can show whether the model beats the code model, §3/§4.3).
//
// Leakage rules (printed on every result): features from t0 only (the export enforces this: `features`
// is the t0 snapshot row); labels after t0; no future feeds (the export's `feeds` are the hour BEFORE
// t0). The harness recomputes nothing from after t0, so `leakage_checks` are all true by construction and
// the result says so; a caller that hands in a dirty predicate still cannot see the future because the
// predicate only ever receives the t0 `features`.

import type { ExportDoc, ExportRecord } from '@dexterm/recorder';
import type { Label } from '@dexterm/recorder';
import { rugFeaturesFromRecord, type RugModel } from './rug-model.ts';

export const BACKTEST_SCHEMA = 'dexterm/packs/backtest';

export type BacktestKind = 'filter' | 'heuristic' | 'strategy' | 'watch_rule' | 'pack_verdicts';
export type DataTier = 'keyless-proxy' | 'chain-verified' | 'mixed';

export interface CalibrationBucket { bucket: string; n: number; mean_p: number | null; observed: number | null }

export interface BacktestResult {
  n: number;
  base_rate: number;
  flagged?: number;
  tp?: number; fp?: number; fn?: number; tn?: number;
  precision: number | null;
  recall: number | null;
  specificity?: number | null;
  brier: number | null;
  brier_base_rate: number | null;
  auc: number | null;
  calibration?: CalibrationBucket[];
  /** Per-feed breakdown (mandatory for rug models: a model that only learns "feed" is useless, §4.3). */
  by_feed?: Record<string, { n: number; pos: number; flagged: number; tp: number; base_rate: number }>;
  by_label?: Partial<Record<Label, number>>;
  /** Filter subject: outcome distribution for the matched set. */
  matched?: number;
  runner_rate?: number | null;
  runner_rate_base?: number | null;
  median_mcap_ratio?: number | null;
  /** The ten worst misses / false alarms with their t0 numbers so a human can see WHY (§4.4). */
  worst_misses?: { mint: string; symbol: string | null; p: number; label: Label; liq: number | null; mcap: number | null; age_sec: number | null }[];
  worst_false_alarms?: { mint: string; symbol: string | null; p: number; label: Label; liq: number | null; mcap: number | null; age_sec: number | null }[];
  generated_at: string;
  data_tier: DataTier;
  leakage_checks: { features_from_t0_only: boolean; labels_after_t0: boolean; no_future_feeds: boolean };
  note?: string;
}

export interface BacktestRequest {
  kind: BacktestKind;
  horizon_sec: number;
  /** Positive labels for the scored class. Default: rug ∪ dead (the keyless positive class, §4.2). */
  positive_labels?: Label[];
  subject: {
    model?: RugModel;
    /** A predicate over the t0 features, parsed by the caller from the trenchscope filter grammar. */
    filter?: (features: ExportRecord['features']) => boolean;
    filter_text?: string;
    /** pack_verdicts: a lookup of the recorded rug_p for a (mint, t0). */
    verdictRugP?: (mint: string, t0: number) => number | null;
  };
}

const DEFAULT_POSITIVE: Label[] = ['rug', 'dead'];

interface Scored {
  mint: string; symbol: string | null; p: number; y: 0 | 1; label: Label;
  liq: number | null; mcap: number | null; age_sec: number | null; feeds: string[];
}

/** AUC by rank (Mann–Whitney U); null when either class is empty. */
export function aucByRank(scored: { p: number; y: 0 | 1 }[]): number | null {
  const pos = scored.filter((x) => x.y).map((x) => x.p);
  const neg = scored.filter((x) => !x.y).map((x) => x.p);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

function brier(scored: { p: number; y: 0 | 1 }[]): number | null {
  if (!scored.length) return null;
  return scored.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / scored.length;
}

function calibration(scored: { p: number; y: 0 | 1 }[]): CalibrationBucket[] {
  const edges = [0, 0.2, 0.4, 0.6, 0.8, 1.01];
  const out: CalibrationBucket[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i];
    const hi = edges[i + 1];
    const b = scored.filter((x) => x.p >= lo && x.p < hi);
    out.push({
      bucket: `${lo}-${hi >= 1 ? 1 : hi}`,
      n: b.length,
      mean_p: b.length ? round3(b.reduce((a, x) => a + x.p, 0) / b.length) : null,
      observed: b.length ? round3(b.reduce((a, x) => a + x.y, 0) / b.length) : null,
    });
  }
  return out;
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;
const round4 = (x: number): number => Math.round(x * 10000) / 10000;
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Collect the (t0 features, outcome-at-horizon) pairs from an export doc. Only records whose outcome at
 * the requested horizon is observed (label != 'unobserved') are scored; the positive class is
 * `positive_labels`.
 */
function collect(doc: ExportDoc, horizonSec: number, positive: Set<Label>): { record: ExportRecord; label: Label; y: 0 | 1; max_mcap_ratio: number | null; mcap_ratio: number | null }[] {
  const out: { record: ExportRecord; label: Label; y: 0 | 1; max_mcap_ratio: number | null; mcap_ratio: number | null }[] = [];
  for (const rec of doc.records) {
    const o = rec.outcomes[`${horizonSec}`];
    if (!o || o.label === 'unobserved') continue;
    out.push({ record: rec, label: o.label, y: positive.has(o.label) ? 1 : 0, max_mcap_ratio: o.max_mcap_ratio, mcap_ratio: o.mcap_ratio });
  }
  return out;
}

const leakageOK = { features_from_t0_only: true, labels_after_t0: true, no_future_feeds: true } as const;

/** Run a backtest over an export doc. Pure; `now` only stamps `generated_at`. */
export function runBacktest(doc: ExportDoc, req: BacktestRequest, now = Date.now()): BacktestResult {
  const positive = new Set<Label>(req.positive_labels ?? DEFAULT_POSITIVE);
  const rows = collect(doc, req.horizon_sec, positive);
  const base: Omit<BacktestResult, 'n' | 'base_rate' | 'precision' | 'recall' | 'brier' | 'brier_base_rate' | 'auc'> = {
    generated_at: new Date(now).toISOString(),
    data_tier: doc.data_tier,
    leakage_checks: { ...leakageOK },
  };

  if (req.kind === 'strategy') {
    return { n: rows.length, base_rate: 0, precision: null, recall: null, brier: null, brier_base_rate: null, auc: null, ...base, note: 'strategy/paper subject not implemented in this tier (needs the position-fill simulator, §6)' };
  }
  if (req.kind === 'watch_rule') {
    return { n: rows.length, base_rate: 0, precision: null, recall: null, brier: null, brier_base_rate: null, auc: null, ...base, note: 'watch_rule subject not implemented in this tier (needs the rules engine, lane W-01)' };
  }

  if (req.kind === 'filter') {
    return filterResult(rows, req, base);
  }

  // heuristic / pack_verdicts: a probability per row → precision/recall/Brier/AUC/calibration/per-feed.
  const scorer: (rec: ExportRecord) => number | null = req.kind === 'pack_verdicts'
    ? (rec) => (req.subject.verdictRugP ? req.subject.verdictRugP(rec.mint, rec.t0) : null)
    : (rec) => (req.subject.model ? req.subject.model.score(rugFeaturesFromRecord(rec.features)) : null);
  const threshold = req.kind === 'heuristic' ? (req.subject.model?.threshold ?? 0.5) : 0.5;

  const scored: Scored[] = [];
  for (const r of rows) {
    const p = scorer(r.record);
    if (p === null) continue; // pack_verdicts: no recorded verdict for this row → not scored
    scored.push({
      mint: r.record.mint, symbol: str(r.record.features.symbol), p, y: r.y, label: r.label,
      liq: numf(r.record.features.liquidity_usd), mcap: numf(r.record.features.mcap), age_sec: numf(r.record.features.age_sec),
      feeds: r.record.feeds,
    });
  }

  const n = scored.length;
  const pos = scored.filter((x) => x.y).length;
  const baseRate = n ? pos / n : 0;
  const flagged = scored.filter((x) => x.p >= threshold);
  const tp = flagged.filter((x) => x.y).length;
  const fp = flagged.length - tp;
  const fn = pos - tp;
  const tn = n - pos - fp;
  const brierBase = n ? scored.reduce((a, x) => a + (baseRate - x.y) ** 2, 0) / n : null;

  const byFeed: BacktestResult['by_feed'] = {};
  for (const x of scored) {
    for (const f of x.feeds.length ? x.feeds : ['(no-feed)']) {
      const b = (byFeed[f] ??= { n: 0, pos: 0, flagged: 0, tp: 0, base_rate: 0 });
      b.n++; b.pos += x.y; if (x.p >= threshold) { b.flagged++; b.tp += x.y; }
    }
  }
  for (const b of Object.values(byFeed)) b.base_rate = b.n ? round3(b.pos / b.n) : 0;

  const byLabel: Partial<Record<Label, number>> = {};
  for (const x of scored) byLabel[x.label] = (byLabel[x.label] ?? 0) + 1;

  const worstMiss = (x: Scored) => ({ mint: x.mint, symbol: x.symbol, p: round3(x.p), label: x.label, liq: x.liq, mcap: x.mcap, age_sec: x.age_sec });
  const b = brier(scored);
  return {
    n, base_rate: round3(baseRate), flagged: flagged.length, tp, fp, fn, tn,
    precision: flagged.length ? round3(tp / flagged.length) : null,
    recall: pos ? round3(tp / pos) : null,
    specificity: n - pos ? round3(tn / (n - pos)) : null,
    brier: b === null ? null : round4(b),
    brier_base_rate: brierBase === null ? null : round4(brierBase),
    auc: (() => { const a = aucByRank(scored); return a === null ? null : round3(a); })(),
    calibration: calibration(scored),
    by_feed: byFeed,
    by_label: byLabel,
    worst_misses: scored.filter((x) => x.y && x.p < threshold).sort((a, c) => a.p - c.p).slice(0, 10).map(worstMiss),
    worst_false_alarms: scored.filter((x) => !x.y && x.p >= threshold).sort((a, c) => c.p - a.p).slice(0, 10).map(worstMiss),
    ...base,
  };
}

function filterResult(
  rows: { record: ExportRecord; label: Label; y: 0 | 1; max_mcap_ratio: number | null; mcap_ratio: number | null }[],
  req: BacktestRequest,
  base: Omit<BacktestResult, 'n' | 'base_rate' | 'precision' | 'recall' | 'brier' | 'brier_base_rate' | 'auc'>,
): BacktestResult {
  const pred = req.subject.filter ?? (() => true);
  const matched = rows.filter((r) => pred(r.record.features));
  const n = rows.length;
  const runnerRateAll = n ? rows.filter((r) => r.label === 'runner').length / n : null;
  const runnerRateMatched = matched.length ? matched.filter((r) => r.label === 'runner').length / matched.length : null;
  const byLabel: Partial<Record<Label, number>> = {};
  for (const r of matched) byLabel[r.label] = (byLabel[r.label] ?? 0) + 1;
  const baseRate = n ? rows.filter((r) => r.y).length / n : 0;
  const matchedPosRate = matched.length ? matched.filter((r) => r.y).length / matched.length : null;
  return {
    n, base_rate: round3(baseRate),
    matched: matched.length,
    precision: matchedPosRate === null ? null : round3(matchedPosRate),
    recall: null, brier: null, brier_base_rate: null, auc: null,
    runner_rate: runnerRateMatched === null ? null : round3(runnerRateMatched),
    runner_rate_base: runnerRateAll === null ? null : round3(runnerRateAll),
    median_mcap_ratio: median(matched.map((r) => r.mcap_ratio).filter((x): x is number => x !== null)),
    by_label: byLabel,
    ...base,
    note: req.subject.filter_text ? `filter: ${req.subject.filter_text}` : undefined,
  };
}

const numf = (v: string | number | null): number | null => (typeof v === 'number' ? v : v === null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: string | number | null): string | null => (v === null ? null : String(v));
