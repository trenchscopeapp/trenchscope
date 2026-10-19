// DexScreener adapter (SPEC §3.1 S1). Keyless, read-only.
// Endpoints (docs.dexscreener.com/api/reference, solana-launchpad/docs/dexscreener-api):
//   300 rpm bucket: GET /tokens/v1/{chain}/{csv ≤30}, /token-pairs/v1/{chain}/{mint},
//                   /latest/dex/search?q=, /latest/dex/pairs/{chain}/{pair}
//    60 rpm bucket: GET /token-boosts/top/v1, /token-boosts/latest/v1, /token-profiles/latest/v1

import type { HttpClient } from '../http.ts';
import type { ByWindow, BuySell, Launchpad, Pair, Socials, Token, Window } from '../model.ts';
import { chunk, num, numOrNull } from '../util.ts';

export const DEXSCREENER_BASE = 'https://api.dexscreener.com';
export const DS_TOKENS_BATCH = 30;
const CHAIN = 'solana';
const FAST = { source: 'dexscreener', bucket: 'dexscreener' } as const;
const SLOW = { source: 'dexscreener', bucket: 'dexscreener-slow' } as const;
const WINDOWS: Window[] = ['m5', 'h1', 'h6', 'h24'];

// Raw shapes (only the fields we read).
export interface DsRawPair {
  chainId: string;
  dexId: string;
  url?: string;
  pairAddress: string;
  labels?: string[];
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: Partial<Record<Window, { buys?: number; sells?: number }>>;
  volume?: Partial<Record<Window, number>>;
  priceChange?: Partial<Record<Window, number>>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: { label?: string; url: string }[];
    socials?: { type: string; url: string }[];
  };
}

export interface DsRawBoost {
  url?: string;
  chainId: string;
  tokenAddress: string;
  amount?: number;
  totalAmount?: number;
  icon?: string;
  description?: string;
  links?: { type?: string; label?: string; url: string }[];
}

/** token-profiles/latest/v1 entry (same 60rpm bucket as boosts). `description` is untrusted. */
export interface DsRawProfile {
  url?: string;
  chainId: string;
  tokenAddress: string;
  icon?: string;
  description?: string;
}

/** Promoted-token signal (boosts). `description` is untrusted text: firewall before any model sees it (CL-06). */
export interface Boost {
  mint: string;
  amount: number | null;
  totalAmount: number | null;
  fetchedAt: number;
}

export interface DsTokenView {
  pair: Pair;
  token: Token;
}

export function normalizePair(raw: DsRawPair, fetchedAt: number): Pair {
  const txns = {} as ByWindow<BuySell>;
  const volume = {} as ByWindow<number | null>;
  const priceChange = {} as ByWindow<number | null>;
  for (const w of WINDOWS) {
    txns[w] = { buys: num(raw.txns?.[w]?.buys), sells: num(raw.txns?.[w]?.sells) };
    volume[w] = numOrNull(raw.volume?.[w]);
    priceChange[w] = numOrNull(raw.priceChange?.[w]);
  }
  return {
    source: 'dexscreener',
    fetchedAt,
    pairAddress: raw.pairAddress,
    dex: raw.dexId,
    baseMint: raw.baseToken.address,
    quoteMint: raw.quoteToken.address,
    priceUsd: num(raw.priceUsd),
    priceNative: num(raw.priceNative),
    liquidityUsd: numOrNull(raw.liquidity?.usd),
    fdv: numOrNull(raw.fdv),
    mcap: numOrNull(raw.marketCap),
    txns,
    volume,
    priceChange,
    createdAt: numOrNull(raw.pairCreatedAt),
  };
}

export function socialsFromPair(raw: DsRawPair): Socials {
  const s: Socials = { x: null, tg: null, web: null };
  for (const so of raw.info?.socials ?? []) {
    if ((so.type === 'twitter' || so.type === 'x') && !s.x) s.x = so.url;
    if (so.type === 'telegram' && !s.tg) s.tg = so.url;
  }
  s.web = raw.info?.websites?.[0]?.url ?? null;
  return s;
}

export function launchpadFromPair(raw: DsRawPair): Launchpad {
  const dex = raw.dexId.toLowerCase();
  const mint = raw.baseToken.address;
  if (dex.startsWith('pump') || mint.endsWith('pump')) return 'pump.fun';
  if (mint.endsWith('bonk')) return 'bonk';
  if (dex.includes('dbc') || raw.labels?.some((l) => l.toLowerCase() === 'dbc')) return 'dbc';
  return 'unknown';
}

/** Token as far as DexScreener knows it (no decimals, no verification). */
export function tokenFromPair(raw: DsRawPair, fetchedAt: number): Token {
  return {
    source: 'dexscreener',
    fetchedAt,
    mint: raw.baseToken.address,
    symbol: raw.baseToken.symbol,
    name: raw.baseToken.name,
    decimals: null,
    launchpad: launchpadFromPair(raw),
    createdAt: numOrNull(raw.pairCreatedAt),
    image: raw.info?.imageUrl ?? null,
    socials: socialsFromPair(raw),
    verified: false,
    sus: false,
  };
}

/**
 * Pick the pair that represents each mint: pairs where the mint is the base
 * token, highest USD liquidity first.
 */
export function bestPairByMint(raws: DsRawPair[], mints?: Iterable<string>): Map<string, DsRawPair> {
  const wanted = mints ? new Set(mints) : undefined;
  const best = new Map<string, DsRawPair>();
  for (const r of raws) {
    if (r.chainId !== CHAIN) continue;
    const mint = r.baseToken?.address;
    if (!mint || (wanted && !wanted.has(mint))) continue;
    const cur = best.get(mint);
    if (!cur || num(r.liquidity?.usd) > num(cur.liquidity?.usd)) best.set(mint, r);
  }
  return best;
}

/** A best pair under this liquidity is rechecked against the per-token endpoint (see tokensRaw). */
export const DEAD_PAIR_LIQ_USD = 1_000;
/** At most this many rechecks per tokensRaw call, so a page of dead coins cannot flood the bucket. */
export const MAX_PAIR_RECHECKS = 6;

export class DexScreener {
  private readonly http: HttpClient;
  readonly base: string;

  constructor(http: HttpClient, base = DEXSCREENER_BASE) {
    this.http = http;
    this.base = base;
  }

  /** All Solana pairs for up to N mints, batched 30 per call (plus a bounded recheck of dead-looking best pairs). */
  async tokensRaw(mints: string[], opts: { recheckDead?: boolean } = {}): Promise<{ pairs: DsRawPair[]; fetchedAt: number; latencyMs: number }> {
    const unique = [...new Set(mints)];
    const pairs: DsRawPair[] = [];
    let fetchedAt = 0;
    let latencyMs = 0;
    for (const batch of chunk(unique, DS_TOKENS_BATCH)) {
      const r = await this.http.getJson<DsRawPair[]>(`${this.base}/tokens/v1/${CHAIN}/${batch.join(',')}`, FAST);
      if (Array.isArray(r.data)) pairs.push(...r.data);
      fetchedAt = Math.max(fetchedAt, r.fetchedAt);
      latencyMs += r.latencyMs;
    }
    // The batch endpoint can omit a coin's live pair and return only a dead one (MEGA, 2026-10-18: a $71 Meteora
    // pool at -99.99 % while a $50K Raydium pair traded). When the best batch pair looks dead, ask the per-token
    // endpoint once and merge its pairs. Bounded per call; a failure keeps the batch answer.
    const seen = new Set(pairs.map((p) => p.pairAddress));
    const suspect = opts.recheckDead === false ? [] : [...bestPairByMint(pairs, unique)]
      .filter(([, p]) => p.dexId !== 'pumpfun' && (p.liquidity?.usd ?? 0) < DEAD_PAIR_LIQ_USD)
      .map(([m]) => m)
      .slice(0, MAX_PAIR_RECHECKS);
    for (const m of suspect) {
      try {
        const r = await this.http.getJson<DsRawPair[]>(`${this.base}/token-pairs/v1/${CHAIN}/${m}`, FAST);
        for (const p of Array.isArray(r.data) ? r.data : []) if (p?.chainId === CHAIN && !seen.has(p.pairAddress)) { pairs.push(p); seen.add(p.pairAddress); }
        latencyMs += r.latencyMs;
      } catch { /* keep the batch answer */ }
    }
    return { pairs, fetchedAt, latencyMs };
  }

  /** Best pair + token per mint. Mints DexScreener does not know are absent from the map. */
  async tokens(mints: string[], opts: { recheckDead?: boolean } = {}): Promise<Map<string, DsTokenView>> {
    const { pairs, fetchedAt } = await this.tokensRaw(mints, opts);
    const out = new Map<string, DsTokenView>();
    for (const [mint, raw] of bestPairByMint(pairs, mints)) {
      out.set(mint, { pair: normalizePair(raw, fetchedAt), token: tokenFromPair(raw, fetchedAt) });
    }
    return out;
  }

  /**
   * task-1401: the coin a pair (pool) trades. A dexscreener.com/solana/<address> link usually names the POOL, not
   * the mint, so a pasted link is resolved here before the token screen opens. Null when DexScreener has no Solana
   * pair at that address (the caller then treats it as a mint). The side that is not wrapped SOL wins.
   */
  async pairCoin(pairAddress: string): Promise<string | null> {
    const r = await this.http.getJson<{ pairs?: DsRawPair[] | null; pair?: DsRawPair | null }>(`${this.base}/latest/dex/pairs/${CHAIN}/${encodeURIComponent(pairAddress)}`, FAST);
    const list = r.data?.pairs ?? (r.data?.pair ? [r.data.pair] : []);
    const p = (Array.isArray(list) ? list : []).find((x) => x?.chainId === CHAIN && x.pairAddress === pairAddress);
    if (!p) return null;
    const WSOL = 'So11111111111111111111111111111111111111112';
    return p.baseToken?.address === WSOL && p.quoteToken?.address ? p.quoteToken.address : p.baseToken?.address ?? null;
  }

  async tokenPairs(mint: string): Promise<Pair[]> {
    const r = await this.http.getJson<DsRawPair[]>(`${this.base}/token-pairs/v1/${CHAIN}/${mint}`, FAST);
    return (Array.isArray(r.data) ? r.data : []).filter((p) => p.chainId === CHAIN).map((p) => normalizePair(p, r.fetchedAt));
  }

  async search(query: string): Promise<DsTokenView[]> {
    const r = await this.http.getJson<{ pairs?: DsRawPair[] }>(`${this.base}/latest/dex/search?q=${encodeURIComponent(query)}`, FAST);
    return (r.data.pairs ?? [])
      .filter((p) => p.chainId === CHAIN)
      .map((p) => ({ pair: normalizePair(p, r.fetchedAt), token: tokenFromPair(p, r.fetchedAt) }));
  }

  async boostsTop(): Promise<Boost[]> {
    return this.boosts('/token-boosts/top/v1');
  }

  async boostsLatest(): Promise<Boost[]> {
    return this.boosts('/token-boosts/latest/v1');
  }

  /** Solana mints with a freshly-updated token profile (socials/description); a wide discovery net. */
  async profilesLatest(): Promise<string[]> {
    const r = await this.http.getJson<DsRawProfile[]>(`${this.base}/token-profiles/latest/v1`, SLOW);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of Array.isArray(r.data) ? r.data : []) {
      if (p.chainId !== CHAIN || !p.tokenAddress || seen.has(p.tokenAddress)) continue;
      seen.add(p.tokenAddress);
      out.push(p.tokenAddress);
    }
    return out;
  }

  private async boosts(path: string): Promise<Boost[]> {
    const r = await this.http.getJson<DsRawBoost[]>(`${this.base}${path}`, SLOW);
    const seen = new Set<string>();
    const out: Boost[] = [];
    for (const b of Array.isArray(r.data) ? r.data : []) {
      if (b.chainId !== CHAIN || seen.has(b.tokenAddress)) continue;
      seen.add(b.tokenAddress);
      out.push({ mint: b.tokenAddress, amount: numOrNull(b.amount), totalAmount: numOrNull(b.totalAmount), fetchedAt: r.fetchedAt });
    }
    return out;
  }
}
