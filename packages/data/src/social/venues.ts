// @dexterm/data — keyless trending venues (task-1330; design §4 "fast layer", §5.3 venue blend).
//   Jupiter tokens v2 toptrending/1h + toporganicscore/1h   (jupiter bucket, 30 rpm, burst 1)
//   GeckoTerminal trending_pools (solana)                    (geckoterminal bucket, shared with candles)
//   DexScreener token-boosts/top                              (dexscreener-slow bucket) → NEGATIVE weight
//   CoinGecko search/trending                                 (coingecko bucket, 10/min) → macro only
// Every call goes through the shared HttpClient (health gate, limiter, Retry-After), one call per source
// per refresh cycle, sequentially — the limiter paces, this code never retries.

import type { HttpClient } from '../http.ts';
import type { DexScreener } from '../sources/dexscreener.ts';
import type { Jupiter, JupTokenView } from '../sources/jupiter.ts';
import { GECKOTERMINAL_BASE } from '../sources/geckoterminal.ts';
import { numOrNull } from '../util.ts';
import type { VenueSignal } from './model.ts';

export const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const GECKO_META = { source: 'geckoterminal', bucket: 'geckoterminal' } as const;
const CG_META = { source: 'coingecko', bucket: 'coingecko' } as const;

export interface GtTrendingPool {
  mint: string | null;
  name: string;
  symbol: string | null;
  priceChange1h: number | null;
  volume24hUsd: number | null;
  reserveUsd: number | null;
  rank: number;
}

export interface CgTrendingCoin {
  id: string;
  symbol: string;
  name: string;
  marketCapRank: number | null;
  priceChange24h: number | null;
  rank: number;
}

interface GtRawTrendingPool {
  id?: string;
  attributes?: {
    name?: string;
    address?: string;
    price_change_percentage?: { h1?: string | number };
    volume_usd?: { h24?: string | number };
    reserve_in_usd?: string | number;
  };
  relationships?: { base_token?: { data?: { id?: string } } };
}

interface CgRawTrending {
  coins?: { item?: { id?: string; symbol?: string; name?: string; market_cap_rank?: number; data?: { price_change_percentage_24h?: { usd?: number } } } }[];
}

const stripNetwork = (id: string | undefined): string | null => { if (!id) return null; const i = id.indexOf('_'); return i >= 0 ? id.slice(i + 1) : id; };

export function parseGeckoTrending(raw: { data?: GtRawTrendingPool[] } | undefined): GtTrendingPool[] {
  const out: GtTrendingPool[] = [];
  (raw?.data ?? []).forEach((p, i) => {
    const name = p.attributes?.name ?? '';
    const symbol = name.includes('/') ? name.split('/')[0].trim() : null;
    out.push({
      mint: stripNetwork(p.relationships?.base_token?.data?.id),
      name, symbol: symbol || null,
      priceChange1h: numOrNull(p.attributes?.price_change_percentage?.h1),
      volume24hUsd: numOrNull(p.attributes?.volume_usd?.h24),
      reserveUsd: numOrNull(p.attributes?.reserve_in_usd),
      rank: i + 1,
    });
  });
  return out;
}

export function parseCoinGeckoTrending(raw: CgRawTrending | undefined): CgTrendingCoin[] {
  const out: CgTrendingCoin[] = [];
  (raw?.coins ?? []).forEach((c, i) => {
    const it = c.item;
    if (!it?.symbol) return;
    out.push({ id: it.id ?? '', symbol: String(it.symbol).toUpperCase(), name: it.name ?? '', marketCapRank: numOrNull(it.market_cap_rank), priceChange24h: numOrNull(it.data?.price_change_percentage_24h?.usd), rank: i + 1 });
  });
  return out;
}

export interface VenueCollection {
  signals: Map<string, VenueSignal>;
  /** Per-source failure text (health registry has the state; this is the caption). */
  errors: Partial<Record<'jup' | 'org' | 'gecko' | 'boost' | 'cg', string>>;
  /** Per-source fetchedAt (ms) for the header ages; absent when the source failed this cycle. */
  fetchedAt: Partial<Record<'jup' | 'org' | 'gecko' | 'boost' | 'cg', number>>;
  /** CoinGecko symbols seen (macro context; matched to board symbols by the feed). */
  coingecko: CgTrendingCoin[];
}

/**
 * Volume velocity: 1h USD volume × 24 ÷ 24h USD volume (1 = flat hour; 9 = the hour ran 9× its share). A token
 * whose whole 24 h volume IS the last hour (a fresh launch) has no baseline: null = "new", never 24× (the same
 * "2 samples minimum" rule the post velocity follows).
 */
export function volumeVelocity(vol1h: number | null, vol24h: number | null): number | null {
  if (vol1h === null || vol24h === null || vol24h <= 0) return null;
  if (vol1h >= vol24h * 0.98) return null;
  return Math.round(((vol1h * 24) / vol24h) * 10) / 10;
}

export class TrendingVenues {
  private readonly http: HttpClient;
  private readonly jupiter: Jupiter;
  private readonly dexscreener: DexScreener;

  constructor(deps: { http: HttpClient; jupiter: Jupiter; dexscreener: DexScreener }) {
    this.http = deps.http;
    this.jupiter = deps.jupiter;
    this.dexscreener = deps.dexscreener;
  }

  jupiterTrending(): Promise<JupTokenView[]> { return this.jupiter.category('toptrending', '1h'); }
  jupiterOrganic(): Promise<JupTokenView[]> { return this.jupiter.category('toporganicscore', '1h'); }

  async geckoTrending(): Promise<{ pools: GtTrendingPool[]; fetchedAt: number }> {
    const r = await this.http.getJson<{ data?: GtRawTrendingPool[] }>(`${GECKOTERMINAL_BASE}/networks/solana/trending_pools?page=1`, GECKO_META);
    return { pools: parseGeckoTrending(r.data), fetchedAt: r.fetchedAt };
  }

  async coingeckoTrending(): Promise<{ coins: CgTrendingCoin[]; fetchedAt: number }> {
    const r = await this.http.getJson<CgRawTrending>(`${COINGECKO_BASE}/search/trending`, CG_META);
    return { coins: parseCoinGeckoTrending(r.data), fetchedAt: r.fetchedAt };
  }

  /**
   * One refresh cycle: five calls, sequential, each failure recorded and skipped (a down venue degrades
   * the board visibly through the health registry; it never blanks the others).
   */
  async collect(symbolOf: (mint: string) => string | null = () => null): Promise<VenueCollection> {
    const errors: VenueCollection['errors'] = {};
    const fetchedAt: VenueCollection['fetchedAt'] = {};
    const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 80);
    let trending: JupTokenView[] = [];
    let organic: JupTokenView[] = [];
    let gecko: GtTrendingPool[] = [];
    let boosts: { mint: string; totalAmount: number | null }[] = [];
    let cg: CgTrendingCoin[] = [];
    try { trending = await this.jupiterTrending(); fetchedAt.jup = trending[0]?.token.fetchedAt ?? Date.now(); } catch (e) { errors.jup = msg(e); }
    try { organic = await this.jupiterOrganic(); fetchedAt.org = organic[0]?.token.fetchedAt ?? Date.now(); } catch (e) { errors.org = msg(e); }
    try { const g = await this.geckoTrending(); gecko = g.pools; fetchedAt.gecko = g.fetchedAt; } catch (e) { errors.gecko = msg(e); }
    try { const b = await this.dexscreener.boostsTop(); boosts = b; fetchedAt.boost = b[0]?.fetchedAt ?? Date.now(); } catch (e) { errors.boost = msg(e); }
    try { const c = await this.coingeckoTrending(); cg = c.coins; fetchedAt.cg = c.fetchedAt; } catch (e) { errors.cg = msg(e); }
    return { signals: mergeVenueSignals({ trending, organic, gecko, boosts, coingecko: cg, symbolOf }), errors, fetchedAt, coingecko: cg };
  }
}

export interface MergeInput {
  trending: JupTokenView[];
  organic: JupTokenView[];
  gecko: GtTrendingPool[];
  boosts: { mint: string; totalAmount: number | null; fetchedAt?: number }[];
  coingecko: CgTrendingCoin[];
  symbolOf?: (mint: string) => string | null;
}

/** Pure merge of the five result sets into one VenueSignal per mint. */
export function mergeVenueSignals(input: MergeInput): Map<string, VenueSignal> {
  const out = new Map<string, VenueSignal>();
  const cgSymbols = new Set(input.coingecko.map((c) => c.symbol));
  const get = (mint: string, symbol: string | null, fetchedAt: number): VenueSignal => {
    let s = out.get(mint);
    if (!s) {
      s = { mint, symbol: symbol ?? input.symbolOf?.(mint) ?? null, jupTrendingRank: null, jupOrganicRank: null, organicScore: null, geckoTrendingRank: null, boosted: false, boostAmount: null, coingeckoTrending: false, volumeVelocity: null, priceChange1h: null, liquidityUsd: null, sources: [], fetchedAt };
      out.set(mint, s);
    } else if (!s.symbol && symbol) s.symbol = symbol;
    s.fetchedAt = Math.max(s.fetchedAt, fetchedAt);
    return s;
  };
  input.trending.forEach((v, i) => {
    const s = get(v.token.mint, v.token.symbol, v.token.fetchedAt);
    s.jupTrendingRank = i + 1;
    s.organicScore = v.stats.organicScore;
    s.volumeVelocity = volumeVelocity(v.pair.volume.h1, v.pair.volume.h24);
    s.priceChange1h = v.pair.priceChange.h1;
    s.liquidityUsd = v.pair.liquidityUsd;
    if (!s.sources.includes('jup')) s.sources.push('jup');
  });
  input.organic.forEach((v, i) => {
    const s = get(v.token.mint, v.token.symbol, v.token.fetchedAt);
    s.jupOrganicRank = i + 1;
    s.organicScore = s.organicScore ?? v.stats.organicScore;
    s.volumeVelocity = s.volumeVelocity ?? volumeVelocity(v.pair.volume.h1, v.pair.volume.h24);
    s.priceChange1h = s.priceChange1h ?? v.pair.priceChange.h1;
    s.liquidityUsd = s.liquidityUsd ?? v.pair.liquidityUsd;
    if (!s.sources.includes('org')) s.sources.push('org');
  });
  for (const p of input.gecko) {
    if (!p.mint) continue;
    const s = get(p.mint, p.symbol, Date.now());
    s.geckoTrendingRank = p.rank;
    s.priceChange1h = s.priceChange1h ?? p.priceChange1h;
    s.liquidityUsd = s.liquidityUsd ?? p.reserveUsd;
    if (!s.sources.includes('gecko')) s.sources.push('gecko');
  }
  for (const b of input.boosts) {
    const s = get(b.mint, null, b.fetchedAt ?? Date.now());
    s.boosted = true;
    s.boostAmount = b.totalAmount;
    if (!s.sources.includes('boost')) s.sources.push('boost');
  }
  for (const s of out.values()) {
    if (s.symbol && cgSymbols.has(s.symbol.toUpperCase())) { s.coingeckoTrending = true; if (!s.sources.includes('cg')) s.sources.push('cg'); }
  }
  return out;
}
