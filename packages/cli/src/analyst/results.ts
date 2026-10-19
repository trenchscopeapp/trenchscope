// trenchscope — resolve an analyst "list of coins" answer against LIVE data (task-1313 part F).
//
// The analyst returns a structured `results: [{ mint, symbol?, reason }]` block; the UI renders it as a
// real table. The numbers (price / 24h / liq / vol / mcap / age) must come from the app's own data layer
// by mint, NEVER from the model's text — so this module looks each mint up in what the app already knows
// (the filtered screener view, the new-pairs stream, the watchlist) and drops any mint it cannot find.
// That is also the trust boundary for the list: a mint the token text invented, not on screen and not
// fetched by a tool, resolves to nothing and is never shown.
import type { AppState } from '../state.ts';
import type { ScreenerRow } from '../screener/rows.ts';
import { screenerView } from '../screener/view.ts';

/** One resolved list row: the analyst's reason plus numbers read from live data by mint. */
export interface ResolvedResult {
  mint: string;
  symbol: string;
  reason: string;
  price: number | null;
  chg24: number | null;
  liq: number | null;
  vol24: number | null;
  mcap: number | null;
  ageMin: number | null;
}

/**
 * Resolve the analyst's `results` list to live rows. Only mints the app already knows are kept; unknown
 * mints are ignored. Pure; safe for the renderer and tests. In fixtures / no-live mode nothing resolves
 * (the list answer is a live-mode feature).
 */
export function resolveAnalystResults(state: AppState, results: readonly { mint: string; symbol?: string; reason: string }[]): ResolvedResult[] {
  if (!results.length) return [];
  const live = state.live && state.screener.source !== 'fixtures' ? state.live : null;
  if (!live) return [];
  const byMint = new Map<string, ScreenerRow>();
  for (const r of screenerView(state.screener)) if (r.mint) byMint.set(r.mint, r);
  const out: ResolvedResult[] = [];
  for (const res of results) {
    const sr = byMint.get(res.mint);
    if (sr) {
      out.push({ mint: sr.mint, symbol: sr.symbol, reason: res.reason, price: sr.price, chg24: sr.chg.h24, liq: sr.liq, vol24: sr.vol24, mcap: sr.mcap, ageMin: sr.ageMin });
      continue;
    }
    const np = live.newpairs.list().find((x) => x.mint === res.mint);
    if (np) {
      out.push({ mint: np.mint, symbol: np.symbol, reason: res.reason, price: np.price ?? null, chg24: null, liq: np.liq ?? null, vol24: null, mcap: null, ageMin: null });
      continue;
    }
    const w = live.watch.list().find((x) => x.entry.mint === res.mint);
    if (w) {
      const row = w.row;
      out.push({ mint: w.entry.mint, symbol: w.entry.symbol, reason: res.reason, price: row?.price ?? null, chg24: row?.chg.h24 ?? null, liq: row?.liq ?? null, vol24: row?.vol24 ?? null, mcap: row?.mcap ?? null, ageMin: row?.ageMin ?? null });
      continue;
    }
    // Unknown mint (not on screen, not fetched): dropped — never shown on the strength of model text.
  }
  return out;
}
