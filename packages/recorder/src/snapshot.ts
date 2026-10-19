// Normalised record -> snapshot columns. Pure functions over the data layer's `EnrichedRow` (the
// screener's normalised Token+Pair+Stats+Audit record, AI-SUITE-DESIGN §4.1 "hook on the data layer's
// normaliser") and over a bare `DsTokenView` (what an outcome sweep gets back). The change-detection
// hash covers every stored column except the ones derived from the clock (t, age_sec), so a refresh
// that returns the same numbers writes nothing.

import { createHash } from 'node:crypto';
import type { DsTokenView, EnrichedRow, SourceId } from '@dexterm/data';

export type SnapshotKind = 'live' | 'sweep';

/** The columns of one token_snapshots row (names match the table). */
export interface SnapshotColumns {
  mint: string;
  symbol: string | null;
  name: string | null;
  launchpad: string | null;
  created_at: number | null;
  price_usd: number | null;
  mcap: number | null;
  /** The MCAP the screener shows after the cross-source rule (Store.resolveMcap); null for sweep rows. */
  mcap_resolved: number | null;
  mcap_flagged: number | null;
  fdv: number | null;
  liquidity_usd: number | null;
  vol_m5: number | null; vol_h1: number | null; vol_h6: number | null; vol_h24: number | null;
  buys_m5: number | null; sells_m5: number | null; buys_h1: number | null; sells_h1: number | null; buys_h24: number | null; sells_h24: number | null;
  chg_m5: number | null; chg_h1: number | null; chg_h6: number | null; chg_h24: number | null;
  pair_address: string | null;
  dex: string | null;
  pair_created_at: number | null;
  src_market: 'dexscreener' | 'jupiter-tokens' | 'none';
  holder_count: number | null;
  holders_chg_pct: number | null;
  top_holders_pct: number | null;
  dev_pct: number | null;
  dev_mints: number | null;
  organic_score: number | null;
  num_traders_h1: number | null;
  net_buyers_h1: number | null;
  buy_vol_h1: number | null;
  sell_vol_h1: number | null;
  mint_auth_enabled: number | null;
  freeze_auth_enabled: number | null;
  is_verified: number | null;
  is_sus: number | null;
  src_audit: string | null;
  rug_score: number | null;
  lp_locked_pct: number | null;
  src_risk: string | null;
  sources: SourceId[];
}

export interface Snapshot {
  columns: SnapshotColumns;
  /** Newest fetchedAt among the parts (the moment the numbers were true). */
  t: number;
  hash: string;
  /** The normalised record as the data layer holds it (minus nothing): stored only for focus rows. */
  raw: unknown;
}

/** Max stored length of a symbol / name (firewalled strings, SPEC §5.3). */
export const SYMBOL_MAX = 16;
export const NAME_MAX = 64;

/**
 * Terminal/model safety for stored strings: drop control, bidi, zero-width and BOM code points,
 * collapse whitespace, cap the length. Same intent as the prototype's `clean()`; names are never
 * fed to a model raw (they go through the Analyst firewall when they are).
 */
export function cleanText(s: unknown, max: number): string | null {
  if (s === null || s === undefined) return null;
  let out = '';
  for (const ch of String(s).normalize('NFC')) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) continue;
    if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 || cp === 0xfeff) continue;
    if ((cp >= 0x200e && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) continue;
    out += ch;
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > max ? out.slice(0, max) + '…' : out;
}

const fin = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: boolean | null | undefined): number | null => (v === null || v === undefined ? null : v ? 1 : 0);

/** Snapshot columns from the screener's normalised row; `hash` is the exact-record hash (identity, not the change rule). */
export function fromEnrichedRow(r: EnrichedRow): Snapshot {
  const { token, pair, stats, audit } = r;
  const h1 = stats?.perWindow.h1 ?? null;
  const src: SnapshotColumns['src_market'] = pair.source === 'dexscreener' ? 'dexscreener' : pair.source === 'jupiter-tokens' ? 'jupiter-tokens' : 'none';
  const columns: SnapshotColumns = {
    mint: r.mint,
    symbol: cleanText(token.symbol, SYMBOL_MAX),
    name: cleanText(token.name, NAME_MAX),
    launchpad: token.launchpad ?? null,
    created_at: fin(token.createdAt ?? pair.createdAt),
    price_usd: fin(pair.priceUsd),
    mcap: fin(pair.mcap),
    mcap_resolved: fin(r.mcap?.value),
    mcap_flagged: r.mcap ? (r.mcap.flagged ? 1 : 0) : null,
    fdv: fin(pair.fdv),
    liquidity_usd: fin(pair.liquidityUsd),
    vol_m5: fin(pair.volume.m5), vol_h1: fin(pair.volume.h1), vol_h6: fin(pair.volume.h6), vol_h24: fin(pair.volume.h24),
    buys_m5: fin(pair.txns.m5?.buys), sells_m5: fin(pair.txns.m5?.sells),
    buys_h1: fin(pair.txns.h1?.buys), sells_h1: fin(pair.txns.h1?.sells),
    buys_h24: fin(pair.txns.h24?.buys), sells_h24: fin(pair.txns.h24?.sells),
    chg_m5: fin(pair.priceChange.m5), chg_h1: fin(pair.priceChange.h1), chg_h6: fin(pair.priceChange.h6), chg_h24: fin(pair.priceChange.h24),
    pair_address: pair.pairAddress || null,
    dex: pair.dex && pair.dex !== 'unknown' ? pair.dex : null,
    pair_created_at: src === 'dexscreener' ? fin(pair.createdAt) : null,
    src_market: src,
    holder_count: fin(stats?.holderCount),
    holders_chg_pct: fin(stats?.holders24hDelta),
    top_holders_pct: fin(audit?.top10Pct),
    dev_pct: fin(audit?.devPct),
    dev_mints: fin(audit?.devMints),
    organic_score: fin(stats?.organicScore),
    num_traders_h1: fin(h1?.numTraders),
    net_buyers_h1: fin(h1?.numNetBuyers),
    buy_vol_h1: fin(h1?.buyVol),
    sell_vol_h1: fin(h1?.sellVol),
    mint_auth_enabled: bool(audit?.mintAuthority),
    freeze_auth_enabled: bool(audit?.freezeAuthority),
    is_verified: bool(token.verified),
    is_sus: bool(token.sus),
    src_audit: audit?.source ?? null,
    rug_score: fin(audit?.rugScore),
    lp_locked_pct: fin(audit?.lpLockedPct),
    src_risk: null,
    sources: [...r.sources],
  };
  const t = Math.max(token.fetchedAt || 0, pair.fetchedAt || 0, stats?.fetchedAt ?? 0, audit?.fetchedAt ?? 0);
  return { columns, t, hash: hashColumns(columns), raw: { token, pair, stats: stats ?? null, audit: audit ?? null, mcap: r.mcap ?? null } };
}

/**
 * Snapshot columns from a DexScreener pair view (an outcome sweep). Identity fields the pair does not
 * carry (launchpad, created_at from Jupiter) are taken from `base`, the mint's last stored row.
 */
export function fromDsView(mint: string, view: DsTokenView | undefined, base: Partial<Pick<SnapshotColumns, 'symbol' | 'name' | 'launchpad' | 'created_at'>> | undefined, fetchedAt: number): Snapshot {
  const empty: SnapshotColumns = {
    mint, symbol: base?.symbol ?? null, name: base?.name ?? null, launchpad: base?.launchpad ?? null, created_at: base?.created_at ?? null,
    price_usd: null, mcap: null, mcap_resolved: null, mcap_flagged: null, fdv: null, liquidity_usd: null,
    vol_m5: null, vol_h1: null, vol_h6: null, vol_h24: null, buys_m5: null, sells_m5: null, buys_h1: null, sells_h1: null, buys_h24: null, sells_h24: null,
    chg_m5: null, chg_h1: null, chg_h6: null, chg_h24: null, pair_address: null, dex: null, pair_created_at: null, src_market: 'none',
    holder_count: null, holders_chg_pct: null, top_holders_pct: null, dev_pct: null, dev_mints: null, organic_score: null,
    num_traders_h1: null, net_buyers_h1: null, buy_vol_h1: null, sell_vol_h1: null, mint_auth_enabled: null, freeze_auth_enabled: null,
    is_verified: null, is_sus: null, src_audit: null, rug_score: null, lp_locked_pct: null, src_risk: null, sources: [],
  };
  if (!view) return { columns: empty, t: fetchedAt, hash: hashColumns(empty), raw: { note: 'no DexScreener pair returned' } };
  const { pair, token } = view;
  const columns: SnapshotColumns = {
    ...empty,
    symbol: empty.symbol ?? cleanText(token.symbol, SYMBOL_MAX),
    name: empty.name ?? cleanText(token.name, NAME_MAX),
    launchpad: empty.launchpad ?? token.launchpad ?? null,
    created_at: empty.created_at ?? fin(pair.createdAt),
    price_usd: fin(pair.priceUsd), mcap: fin(pair.mcap), fdv: fin(pair.fdv), liquidity_usd: fin(pair.liquidityUsd),
    vol_m5: fin(pair.volume.m5), vol_h1: fin(pair.volume.h1), vol_h6: fin(pair.volume.h6), vol_h24: fin(pair.volume.h24),
    buys_m5: fin(pair.txns.m5?.buys), sells_m5: fin(pair.txns.m5?.sells), buys_h1: fin(pair.txns.h1?.buys), sells_h1: fin(pair.txns.h1?.sells),
    buys_h24: fin(pair.txns.h24?.buys), sells_h24: fin(pair.txns.h24?.sells),
    chg_m5: fin(pair.priceChange.m5), chg_h1: fin(pair.priceChange.h1), chg_h6: fin(pair.priceChange.h6), chg_h24: fin(pair.priceChange.h24),
    pair_address: pair.pairAddress || null, dex: pair.dex || null, pair_created_at: fin(pair.createdAt),
    src_market: 'dexscreener', sources: ['dexscreener'],
  };
  return { columns, t: pair.fetchedAt || fetchedAt, hash: hashColumns(columns), raw: { token, pair } };
}

/** Stable hash of the columns (key order fixed by the interface literal above). */
export function hashColumns(c: SnapshotColumns): string {
  return createHash('sha256').update(JSON.stringify(c)).digest('base64url').slice(0, 22);
}

export type ChangeDetection = 'material' | 'exact';

/**
 * Material change (task-1329 measurements). The live app holds a ~500-row pool that is re-enriched about
 * once a minute and almost every memecoin price moves a little every time: "hash of the exact record"
 * wrote ~4 rows/s (≈ 120 MB per 8 h day, columns only) and 1 % thresholds + a 5 min heartbeat still
 * ≈ 120 MB/day, against the design's 10 MB estimate for 60 rows. A snapshot is worth a row when
 * something MATERIAL moved against the LAST WRITTEN row (hysteresis: a slow drift is written once it adds
 * up, a value sitting on a threshold never flaps): price / market cap / liquidity by ≥ 5 %, holders by
 * ≥ 10 %, volumes by ≥ 20 %, trade counts by ≥ 25 %, a percentage-change field by ≥ 5 points, a share /
 * score by ≥ 2 points, or any identity / authority / source field at all. The labels work on ratios of
 * 0.5× and 2×, so 5 % resolution loses nothing they can see; the hourly t0 anchor and the heartbeat
 * (30 min) bound how stale a stored row can be.
 */
export const MATERIAL = {
  rel5: ['price_usd', 'mcap', 'mcap_resolved', 'fdv', 'liquidity_usd'] as const,
  rel10: ['holder_count'] as const,
  rel20: ['vol_m5', 'vol_h1', 'vol_h6', 'vol_h24', 'buy_vol_h1', 'sell_vol_h1'] as const,
  rel25: ['buys_m5', 'sells_m5', 'buys_h1', 'sells_h1', 'buys_h24', 'sells_h24', 'num_traders_h1', 'net_buyers_h1'] as const,
  abs5: ['chg_m5', 'chg_h1', 'chg_h6', 'chg_h24', 'holders_chg_pct'] as const,
  abs2: ['top_holders_pct', 'dev_pct', 'organic_score', 'rug_score', 'lp_locked_pct'] as const,
};
const NUMERIC = new Set<string>([...MATERIAL.rel5, ...MATERIAL.rel10, ...MATERIAL.rel20, ...MATERIAL.rel25, ...MATERIAL.abs5, ...MATERIAL.abs2]);

/** Relative to the previous (written) value: 100 → 110 is a 10 % move, 0 → anything is a move. */
function relMoved(a: number | null, b: number | null, frac: number): boolean {
  if (a === null || b === null) return a !== b;
  if (a === b) return false;
  if (a === 0) return true;
  return Math.abs(a - b) / Math.abs(a) >= frac;
}
function absMoved(a: number | null, b: number | null, unit: number): boolean {
  if (a === null || b === null) return a !== b;
  return Math.abs(a - b) >= unit;
}

/** True when `next` differs materially from `prev` (the last written row of the same mint). */
export function isMaterialChange(prev: SnapshotColumns, next: SnapshotColumns): boolean {
  for (const k of MATERIAL.rel5) if (relMoved(prev[k], next[k], 0.05)) return true;
  for (const k of MATERIAL.rel10) if (relMoved(prev[k], next[k], 0.10)) return true;
  for (const k of MATERIAL.rel20) if (relMoved(prev[k], next[k], 0.20)) return true;
  for (const k of MATERIAL.rel25) if (relMoved(prev[k], next[k], 0.25)) return true;
  for (const k of MATERIAL.abs5) if (absMoved(prev[k], next[k], 5)) return true;
  for (const k of MATERIAL.abs2) if (absMoved(prev[k], next[k], 2)) return true;
  for (const k of COLUMN_NAMES) {
    if (NUMERIC.has(k)) continue;
    if (prev[k] !== next[k]) return true;
  }
  return prev.sources.join() !== next.sources.join();
}

/** Column names in insert order (everything in SnapshotColumns except `sources`, which is JSON). */
export const COLUMN_NAMES = [
  'mint', 'symbol', 'name', 'launchpad', 'created_at', 'price_usd', 'mcap', 'mcap_resolved', 'mcap_flagged', 'fdv', 'liquidity_usd',
  'vol_m5', 'vol_h1', 'vol_h6', 'vol_h24', 'buys_m5', 'sells_m5', 'buys_h1', 'sells_h1', 'buys_h24', 'sells_h24',
  'chg_m5', 'chg_h1', 'chg_h6', 'chg_h24', 'pair_address', 'dex', 'pair_created_at', 'src_market',
  'holder_count', 'holders_chg_pct', 'top_holders_pct', 'dev_pct', 'dev_mints', 'organic_score', 'num_traders_h1', 'net_buyers_h1',
  'buy_vol_h1', 'sell_vol_h1', 'mint_auth_enabled', 'freeze_auth_enabled', 'is_verified', 'is_sus', 'src_audit', 'rug_score', 'lp_locked_pct', 'src_risk',
] as const satisfies readonly (keyof SnapshotColumns)[];
