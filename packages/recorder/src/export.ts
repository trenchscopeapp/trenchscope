// Export for the eval / backtest harness (AI-SUITE-DESIGN §4.1 "export": `eval/recorded.json`). One
// record per t0 anchor: the t0 features exactly as the user would have seen them (no later column),
// the feeds that surfaced the mint in the hour before t0, and the outcome per horizon. Leakage rule
// printed in the document: features are from t0 only; labels are after t0.

import type { DatabaseSync } from 'node:sqlite';
import { HORIZONS_SEC } from './schema.ts';
import { COLUMN_NAMES } from './snapshot.ts';
import { LABELER_VERSION, isPositive, type Label, type LabelTier } from './labels.ts';

export const EXPORT_SCHEMA = 'dexterm-recorder-export/1';

export interface ExportOutcome {
  label: Label;
  tier: LabelTier;
  t1: number | null;
  mcap_ratio: number | null;
  liq_ratio: number | null;
  price_ratio: number | null;
  max_mcap_ratio: number | null;
  /** rug ∪ dead on keyless data; rug alone when chain-verified (labels.md). */
  positive: boolean;
}

export interface ExportRecord {
  mint: string;
  t0: number;
  /** Seconds the recorder had known the mint at t0 (0 = first sighting). */
  known_sec: number;
  feeds: string[];
  features: Record<string, string | number | null>;
  outcomes: Partial<Record<`${number}`, ExportOutcome>>;
}

export interface ExportDoc {
  schema: typeof EXPORT_SCHEMA;
  exported_at: string;
  labeler_version: string;
  data_tier: 'keyless-proxy';
  leakage_rule: string;
  horizons_sec: number[];
  counts: { records: number; with_any_outcome: number; by_label: Partial<Record<Label, number>> };
  records: ExportRecord[];
}

export interface ExportOptions {
  /** Only t0 anchors at/after this time (unix ms). */
  since?: number;
  /** Only t0 anchors before this time (unix ms). */
  until?: number;
  /** Drop t0 rows that have no outcome yet (default: keep them, with an empty `outcomes`). */
  labelledOnly?: boolean;
  /** Cap the number of records (newest first when set). */
  limit?: number;
}

const FEATURES = COLUMN_NAMES.filter((c) => c !== 'mint');

export function exportRecorded(db: DatabaseSync, opts: ExportOptions = {}, now = Date.now()): ExportDoc {
  const where: string[] = ['is_t0 = 1'];
  const args: number[] = [];
  if (opts.since !== undefined) { where.push('t >= ?'); args.push(opts.since); }
  if (opts.until !== undefined) { where.push('t < ?'); args.push(opts.until); }
  const limit = opts.limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(opts.limit))}` : '';
  const order = opts.limit !== undefined ? 'DESC' : 'ASC';
  const t0s = db.prepare(`SELECT snap_id, t, ${COLUMN_NAMES.join(', ')} FROM token_snapshots WHERE ${where.join(' AND ')} ORDER BY t ${order}${limit}`).all(...args) as Record<string, string | number | null>[];
  const feedsStmt = db.prepare('SELECT DISTINCT feed FROM feed_members WHERE mint = ? AND t > ? AND t <= ? ORDER BY feed');
  const firstStmt = db.prepare('SELECT first_t FROM mints WHERE mint = ?');
  const outStmt = db.prepare('SELECT horizon_sec, t1, label, label_tier, mcap_ratio, liq_ratio, price_ratio, max_mcap_ratio FROM outcomes WHERE mint = ? AND t0 = ?');
  const records: ExportRecord[] = [];
  const byLabel: Partial<Record<Label, number>> = {};
  let withAny = 0;
  for (const r of t0s) {
    const mint = String(r.mint);
    const t0 = Number(r.t);
    const outcomes: ExportRecord['outcomes'] = {};
    const rows = outStmt.all(mint, t0) as { horizon_sec: number; t1: number | null; label: Label; label_tier: LabelTier; mcap_ratio: number | null; liq_ratio: number | null; price_ratio: number | null; max_mcap_ratio: number | null }[];
    for (const o of rows) {
      outcomes[`${Number(o.horizon_sec)}`] = {
        label: o.label, tier: o.label_tier, t1: o.t1 === null ? null : Number(o.t1),
        mcap_ratio: o.mcap_ratio, liq_ratio: o.liq_ratio, price_ratio: o.price_ratio, max_mcap_ratio: o.max_mcap_ratio,
        positive: isPositive(o.label, o.label_tier),
      };
      byLabel[o.label] = (byLabel[o.label] ?? 0) + 1;
    }
    if (rows.length) withAny++;
    else if (opts.labelledOnly) continue;
    const features: Record<string, string | number | null> = {};
    for (const c of FEATURES) features[c] = r[c] ?? null;
    // age at t0 is derived from the clock, so it is not a stored column (the snapshot hash ignores it). Without
    // this the backtest scored every record as a fresh launch: age_sec was null in every exported row.
    const created = r.created_at ?? r.pair_created_at;
    features.age_sec = typeof created === 'number' && Number.isFinite(created) && created > 0 ? Math.max(0, Math.round((t0 - created) / 1000)) : null;
    const first = firstStmt.get(mint) as { first_t: number } | undefined;
    records.push({
      mint, t0,
      known_sec: first ? Math.max(0, Math.round((t0 - Number(first.first_t)) / 1000)) : 0,
      feeds: (feedsStmt.all(mint, t0 - 3_600_000, t0) as { feed: string }[]).map((f) => f.feed),
      features,
      outcomes,
    });
  }
  if (order === 'DESC') records.reverse();
  return {
    schema: EXPORT_SCHEMA,
    exported_at: new Date(now).toISOString(),
    labeler_version: LABELER_VERSION,
    data_tier: 'keyless-proxy',
    leakage_rule: 'features are the t0 row only (the row the user saw); every outcome is computed from observations strictly after t0; the universe at t is every mint recorded at or before t, dead ones included',
    horizons_sec: [...HORIZONS_SEC],
    counts: { records: records.length, with_any_outcome: withAny, by_label: byLabel },
    records,
  };
}
