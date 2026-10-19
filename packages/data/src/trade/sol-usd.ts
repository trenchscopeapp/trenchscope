// trenchscope T1 — the SOL/USD price the signer prices a trade with (task-1310 round 2, HIGH #2).
//
// The USD caps are only as good as the SOL/USD number behind them: a stale or absurd price (say
// $0.0001) makes a 100 SOL trade look like a cent. The executor therefore never takes a bare number.
// It takes timestamped SAMPLES from named sources and resolves them here, refusing when:
//   * a sample is older than MAX_AGE_MS (60 s) or dated in the future;
//   * a price is outside the plausibility band [MIN_PLAUSIBLE_USD, MAX_PLAUSIBLE_USD] ($1–$10,000);
//   * on MAINNET, fewer than two INDEPENDENT non-Jupiter sources agree within AGREE_PCT (3%). Jupiter
//     is the swap vendor, so its price API is not an independent check of a Jupiter route and can
//     never be the only source.
// The resolved price is the HIGHEST of the agreeing sources: that over-states the notional slightly,
// which is the conservative direction for a cap. Pure; no I/O.

import type { TradeNetwork } from './caps.ts';

export interface SolUsdSample {
  /** USD per SOL. */
  price: number;
  /** Clock ms when the sample was fetched. */
  fetchedAt: number;
  /** Source id, e.g. 'dexscreener', 'geckoterminal', 'jupiter'. */
  source: string;
}

export const SOL_USD_MAX_AGE_MS = 60_000;
export const SOL_USD_MIN_PLAUSIBLE = 1;
export const SOL_USD_MAX_PLAUSIBLE = 10_000;
export const SOL_USD_AGREE_PCT = 3;
/** Sources that are the swap vendor itself (or a re-export of it) and so count as dependent. */
export const SOL_USD_DEPENDENT_SOURCES: ReadonlySet<string> = new Set(['jupiter', 'jupiter-swap', 'jupiter-price', 'jup']);

export type SolUsdResolution =
  | { price: number; sources: string[] }
  | { price: null; reason: string };

function isSample(x: unknown): x is SolUsdSample {
  if (x === null || typeof x !== 'object') return false;
  const s = x as Record<string, unknown>;
  return typeof s.price === 'number' && typeof s.fetchedAt === 'number' && typeof s.source === 'string';
}

function dependent(source: string): boolean {
  const s = source.toLowerCase();
  return SOL_USD_DEPENDENT_SOURCES.has(s) || s.startsWith('jupiter') || s.startsWith('jup-');
}

/**
 * Resolve a SOL/USD price from samples. `input` may be a single sample, an array, or anything else
 * (a bare number, null, undefined) — anything that is not a well-formed sample is ignored, so a legacy
 * `() => 150` feed yields NO price and a mainnet trade is refused ('no-usd-value').
 */
export function resolveSolUsd(input: unknown, now: number, network: TradeNetwork): SolUsdResolution {
  const raw: unknown[] = Array.isArray(input) ? input : input === null || input === undefined ? [] : [input];
  const rejected: string[] = [];
  const fresh = new Map<string, SolUsdSample>(); // one sample per source (the freshest)
  for (const x of raw) {
    if (!isSample(x)) { rejected.push('malformed sample'); continue; }
    const src = x.source.trim().toLowerCase();
    if (src.length === 0) { rejected.push('unnamed source'); continue; }
    if (!Number.isFinite(x.price) || x.price < SOL_USD_MIN_PLAUSIBLE || x.price > SOL_USD_MAX_PLAUSIBLE) { rejected.push(`${src}: implausible $${x.price}`); continue; }
    if (!Number.isFinite(x.fetchedAt) || x.fetchedAt > now + 5_000) { rejected.push(`${src}: bad timestamp`); continue; }
    const age = now - x.fetchedAt;
    if (age > SOL_USD_MAX_AGE_MS) { rejected.push(`${src}: stale (${Math.round(age / 1000)} s)`); continue; }
    const prev = fresh.get(src);
    if (!prev || x.fetchedAt > prev.fetchedAt) fresh.set(src, { price: x.price, fetchedAt: x.fetchedAt, source: src });
  }
  const valid = [...fresh.values()];
  const why = rejected.length > 0 ? ` (${rejected.join('; ')})` : '';

  if (network !== 'mainnet') {
    // Devnet funds have no USD value; one fresh plausible sample from anyone is enough for display.
    if (valid.length === 0) return { price: null, reason: `no fresh SOL/USD sample${why}` };
    const best = valid.reduce((a, b) => (b.price > a.price ? b : a));
    return { price: best.price, sources: [best.source] };
  }

  const independent = valid.filter((s) => !dependent(s.source));
  if (independent.length < 2) {
    const have = independent.length === 1 ? `only ${independent[0].source}` : valid.length > 0 ? 'only the swap vendor' : 'none';
    return { price: null, reason: `mainnet needs two independent non-Jupiter SOL/USD sources; have ${have}${why}` };
  }
  const lo = Math.min(...independent.map((s) => s.price));
  const hi = Math.max(...independent.map((s) => s.price));
  const spreadPct = ((hi - lo) / lo) * 100;
  if (spreadPct > SOL_USD_AGREE_PCT) {
    return { price: null, reason: `SOL/USD sources disagree by ${spreadPct.toFixed(1)}% (${independent.map((s) => `${s.source} $${s.price}`).join(', ')})` };
  }
  return { price: hi, sources: independent.map((s) => s.source) };
}
