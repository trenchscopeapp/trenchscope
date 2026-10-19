// LARP verdict join (task-1359): the app writes the LARP detector's settled product verdicts into the recorder's
// `verdicts` table (pack `larp-check`, via @dexterm/packs recordVerdict) and the LARP eval reads them back here,
// joined to the outcome labels. The prototype DB (research/task-1287/recorder/history.sqlite) has the same
// `verdicts` + `outcomes` columns, so the join runs on both. Reads never throw on a missing table.

import type { DatabaseSync } from 'node:sqlite';
import { isPositive, type Label, type LabelTier } from './labels.ts';

/** The pack name a LARP-detector verdict is stored under. */
export const LARP_PACK = 'larp-check';
/** The product-assessment verdicts the analyst may return (analyst/session.ts). */
export const LARP_VERDICTS = ['REAL_PRODUCT', 'EARLY_BUT_REAL', 'NO_PRODUCT_CLAIMED', 'LARP', 'UNVERIFIABLE'] as const;
export type LarpVerdict = (typeof LARP_VERDICTS)[number];

const hasTable = (db: DatabaseSync, name: string): boolean => {
  try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name); } catch { return false; }
};

export interface LarpJoinRow {
  mint: string;
  t: number;
  verdict: string;
  confidence: number | null;
  /** The outcome of the t0 anchor the verdict was matched to; null = unmatched (no anchor in the window, or unobserved). */
  label: Label | null;
  tier: LabelTier | null;
  positive: boolean | null;
  t0: number | null;
}

export interface LarpJoin {
  horizon_sec: number;
  /** A verdict matches the latest t0 anchor of its mint at most this long BEFORE the verdict (no later anchor). */
  slack_sec: number;
  verdicts_recorded: number;
  rows: LarpJoinRow[];
  /** Observed (non-`unobserved`) outcome labels at this horizon in the DB, i.e. the labelled history size. */
  outcomes_at_horizon: number;
  outcome_counts: Partial<Record<Label, number>>;
  unobserved_at_horizon: number;
}

/**
 * Join every recorded LARP verdict to an outcome label: the latest t0 anchor of the same mint at or before the
 * verdict, no more than `slackSec` earlier (default 10 % of the horizon). The label then describes what the coin
 * did from (just before) the verdict to the horizon; an anchor long before the verdict would let the verdict see
 * most of the outcome window, so it is not matched. `unobserved` labels count as unmatched.
 */
export function readLarpJoin(db: DatabaseSync, horizonSec: number, slackSec = Math.round(horizonSec * 0.1)): LarpJoin {
  const out: LarpJoin = { horizon_sec: horizonSec, slack_sec: slackSec, verdicts_recorded: 0, rows: [], outcomes_at_horizon: 0, outcome_counts: {}, unobserved_at_horizon: 0 };
  if (hasTable(db, 'outcomes')) {
    const counts = db.prepare('SELECT label, COUNT(*) AS n FROM outcomes WHERE horizon_sec = ? GROUP BY label').all(horizonSec) as Array<{ label: Label; n: number }>;
    for (const c of counts) {
      if (c.label === 'unobserved') { out.unobserved_at_horizon += c.n; continue; }
      out.outcome_counts[c.label] = c.n;
      out.outcomes_at_horizon += c.n;
    }
  }
  if (!hasTable(db, 'verdicts')) return out;
  const verdicts = db.prepare('SELECT mint, t, verdict, confidence FROM verdicts WHERE pack = ? AND verdict IS NOT NULL ORDER BY t').all(LARP_PACK) as Array<{ mint: string; t: number; verdict: string; confidence: number | null }>;
  out.verdicts_recorded = verdicts.length;
  const canJoin = hasTable(db, 'outcomes');
  const q = canJoin ? db.prepare('SELECT t0, label, label_tier FROM outcomes WHERE mint = ? AND horizon_sec = ? AND t0 <= ? AND t0 >= ? ORDER BY t0 DESC LIMIT 1') : null;
  for (const v of verdicts) {
    const o = q?.get(v.mint, horizonSec, v.t, v.t - slackSec * 1000) as { t0: number; label: Label; label_tier: LabelTier } | undefined;
    const observed = o && o.label !== 'unobserved' ? o : null;
    out.rows.push({
      mint: v.mint, t: v.t, verdict: v.verdict, confidence: typeof v.confidence === 'number' ? v.confidence : null,
      label: observed?.label ?? null, tier: observed?.label_tier ?? null, positive: observed ? isPositive(observed.label, observed.label_tier) : null, t0: observed?.t0 ?? null,
    });
  }
  return out;
}
