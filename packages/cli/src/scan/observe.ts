// trenchscope AI SCAN MODE (task-1324) — build ScanObservations from data the app ALREADY has. No network:
// the screener feed rows in memory, the DexScreener pair `Store.enrich` already cached under `ds:token`
// (read with a plain Cache.get — the same read live/flow.ts does for the BUY/SELL FLOW panel), the open
// token's loaded view (fast-lane price, candles) and existing LARP verdicts. Nothing here calls the HTTP
// client or the limiter, so a scan tick can never add a request.
import type { BuySell, DsTokenView } from '@dexterm/data';
import type { ScreenerRow } from '../screener/rows.ts';
import type { TokenView } from '../live/token.ts';
import { DS_TOKEN_CACHE_NS } from '../live/flow.ts';
import type { ScanObservation } from './engine.ts';

/** The cache read the scan may do: `Cache.get` (SQLite SELECT, never a fetch). */
export type CacheGet = (ns: string, key: string) => { value: unknown; fetchedAt: number } | undefined;

export interface ObserveSources {
  /** The screener pool (feed rows) currently in memory. */
  rows: readonly ScreenerRow[];
  /** Read-only cache lookup for the cached DexScreener pair (txns per window). */
  cacheGet?: CacheGet;
  /** The open token's live view, if any (its candles + fast-lane price are already loaded). */
  token?: TokenView | null;
  livePrice?: (mint: string) => number | null;
  /** Existing LARP verdicts (task-1315); never computed here. */
  larp?: ReadonlyMap<string, { verdict: string }>;
  now: number;
  /** Liquidity floor before any cache read (the engine's gate). */
  minLiqUsd: number;
  /** At most this many feed rows are observed per pass (highest 5m volume first). */
  max?: number;
}

/** Default cap on observed rows per pass: excitement needs volume, so the top 5m-volume rows. */
export const OBSERVE_MAX = 120;

function txns(get: CacheGet | undefined, mint: string): { m5: BuySell | null; h1: BuySell | null } {
  if (!get) return { m5: null, h1: null };
  let hit: { value: unknown } | undefined;
  try { hit = get(DS_TOKEN_CACHE_NS, mint); } catch { return { m5: null, h1: null }; }
  const pair = (hit?.value as DsTokenView | undefined)?.pair;
  const ok = (b: BuySell | undefined): BuySell | null => (b && Number.isFinite(b.buys) && Number.isFinite(b.sells) ? { buys: b.buys, sells: b.sells } : null);
  return { m5: ok(pair?.txns?.m5), h1: ok(pair?.txns?.h1) };
}

/**
 * A cheap signature of the scan inputs: when it is unchanged the loop skips rebuilding observations
 * (calm-mode CPU). Row count + newest fetch time + the open token's last load + verdict count.
 */
export function observeSig(src: Pick<ObserveSources, 'rows' | 'token' | 'larp'>): string {
  let maxT = 0;
  for (const r of src.rows) if (r.fetchedAt !== null && r.fetchedAt > maxT) maxT = r.fetchedAt;
  return `${src.rows.length}:${maxT}:${src.token?.mint ?? ''}:${src.token?.updatedAt ?? 0}:${src.token?.candles.length ?? 0}:${src.larp?.size ?? 0}`;
}

/** One observation per eligible feed row, plus the open token (merged when it is also a row). */
export function buildObservations(src: ObserveSources): ScanObservation[] {
  const max = src.max ?? OBSERVE_MAX;
  const eligible = src.rows.filter((r) => !r.skeleton && !r.fixture && !!r.mint && r.liq !== null && r.liq >= src.minLiqUsd);
  eligible.sort((a, b) => (b.vol5m ?? 0) - (a.vol5m ?? 0));
  const out = new Map<string, ScanObservation>();
  for (const r of eligible.slice(0, max)) {
    const tx = txns(src.cacheGet, r.mint);
    out.set(r.mint, {
      mint: r.mint, symbol: r.symbol, t: r.fetchedAt ?? src.now,
      price: r.price, vol5m: r.vol5m, vol1h: r.vol1h, vol6h: r.vol6h, vol24: r.vol24,
      liq: r.liq, holders: r.holders, ageMin: r.ageMin, m5: tx.m5, h1: tx.h1,
      candles: null, larp: src.larp?.get(r.mint)?.verdict ?? null, mintAuth: r.mintAuth, freezeAuth: r.freezeAuth,
    });
  }
  const v = src.token;
  if (v && v.mint) {
    const row = out.get(v.mint);
    const tx = row ? { m5: row.m5, h1: row.h1 } : txns(src.cacheGet, v.mint);
    const px = src.livePrice?.(v.mint) ?? v.price;
    if (row || (v.liq !== null && v.liq >= src.minLiqUsd)) {
      out.set(v.mint, {
        mint: v.mint, symbol: v.symbol, t: Math.max(row?.t ?? 0, v.updatedAt ?? 0) || src.now,
        price: px ?? row?.price ?? null,
        vol5m: row?.vol5m ?? null, vol1h: row?.vol1h ?? null, vol6h: row?.vol6h ?? null, vol24: row?.vol24 ?? v.vol24,
        liq: v.liq ?? row?.liq ?? null, holders: v.holders ?? row?.holders ?? null, ageMin: v.ageMin ?? row?.ageMin ?? null,
        m5: tx.m5, h1: tx.h1,
        // the open token's candles are already on screen — the only candles the scan ever reads
        candles: v.candles.length ? v.candles : null,
        larp: src.larp?.get(v.mint)?.verdict ?? null,
        mintAuth: v.mintAuth ?? row?.mintAuth ?? null, freezeAuth: v.freezeAuth ?? row?.freezeAuth ?? null,
      });
    }
  }
  return [...out.values()];
}
