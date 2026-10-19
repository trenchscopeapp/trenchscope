// task-1361: p(rug) for a screener row, from the pre-registered H1-v0.1 heuristic in @dexterm/packs
// (rug-model.ts). Zero model cost, zero requests: it reads the numbers already on the row. It is a MODEL
// OUTPUT, not a fact: every surface that shows it names the model and how old the row's data is.
// H1 is a hand-written additive heuristic (not learned); a trained v1 only replaces it once the recorder
// has enough labelled outcomes and `trenchscope backtest` says it is better (AI-SUITE-DESIGN §4.3).
// The rug model module directly (zero imports), not the packs barrel, so a read-only consumer (the paper bot)
// does not load the packs' backtest modules and, through them, the data barrel.
import { H2_FLAG_THRESHOLD, h2Model, type RugFeatures, type RugModel } from '@dexterm/packs/rug';
import type { ScreenerRow } from './rows.ts';

/** The model the screener column scores with. */
export const SCREENER_RUG_MODEL: RugModel = h2Model();

/** Short label for captions / the sort menu: `H1-v0.1 heuristic`. */
export const RUG_MODEL_LABEL = `${SCREENER_RUG_MODEL.id} ${SCREENER_RUG_MODEL.kind}`;

/** The canonical feature vector from what the screener row carries (nulls where no source said). */
export function rugFeaturesFromRow(r: ScreenerRow): RugFeatures {
  return {
    liquidity_usd: r.liq,
    mcap: r.mcap,
    age_sec: r.ageMin === null ? null : r.ageMin * 60,
    top_holders_pct: r.top10,
    dev_pct: r.dev,
    organic_score: r.org,
    holder_count: r.holders,
    mint_auth_enabled: r.mintAuth,
    freeze_auth_enabled: r.freezeAuth,
    has_pool: r.liq === null ? null : r.liq > 0,
    is_verified: null,
    chg_h1: r.chg.h1, chg_h6: r.chg.h6, chg_h24: r.chg.h24,
    graduated: r.dex === 'pumpswap' ? true : r.dex === 'pumpfun' ? false : r.dex ? true : null,
    bundled_pct: r.bundled,
  };
}

/**
 * p(rug) in [0.02, 0.98] for a row with market data, else null: a skeleton row, or one where no source
 * has reported liquidity, cap, age or an audit yet (the heuristic would only be scoring its own defaults).
 */
export function rugP(r: ScreenerRow): number | null {
  if (r.skeleton) return null;
  if (r.liq === null && r.mcap === null && r.ageMin === null && r.mintAuth === null && r.freezeAuth === null) return null;
  return SCREENER_RUG_MODEL.score(rugFeaturesFromRow(r));
}

/** `0.45` — two decimals, never a percent (it reads as a probability, which is what the backtest measures). */
export function fmtRugP(p: number): string {
  return p.toFixed(2);
}

/** The model's own flag line: at or above it the heuristic calls the token a likely rug. */
export const RUG_FLAG_THRESHOLD = H2_FLAG_THRESHOLD;

/** `42s` / `4m` / `3h` since the row's data was fetched; null when the row never recorded a fetch time. */
export function rugDataAge(r: Pick<ScreenerRow, 'fetchedAt'>, now: number): string | null {
  if (r.fetchedAt === null || !Number.isFinite(r.fetchedAt)) return null;
  const s = Math.max(0, Math.round((now - r.fetchedAt) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
}
