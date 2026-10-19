// Jupiter Tokens API v2 + Price API v3 adapter (SPEC §3.1 S2/S3). Keyless, read-only.
// Docs: solana-launchpad/docs/jupiter/tokens-api.md, tokens-api-list.md;
// rate limits: developers.jup.ag/docs/portal/rate-limits (keyless 0.5 rps, one
// bucket shared by Tokens and Price).
//   GET /tokens/v2/search?query=<csv ≤100 mints | symbol | name>
//   GET /tokens/v2/recent
//   GET /tokens/v2/{toptrending|toporganicscore|toptraded}/{5m|1h|6h|24h}?limit=
//   GET /price/v3?ids=<csv ≤50>
// Host: the documented `api.jup.ag` first; if it refuses keyless access
// (401/403) we switch, for the session, to `lite-api.jup.ag`, which still
// answers keyless (SPEC §9.1).

import { HttpError } from '../http.ts';
import type { HttpClient, JsonResult } from '../http.ts';
import type { Audit, ByWindow, Launchpad, Pair, Socials, Stats, Token, Window, WindowStats } from '../model.ts';
import { chunk, isoToMs, num, numOrNull } from '../util.ts';

export const JUPITER_HOSTS = ['https://api.jup.ag', 'https://lite-api.jup.ag'] as const;
export const JUP_SEARCH_BATCH = 100;
export const JUP_PRICE_BATCH = 50;
export type JupCategory = 'toptrending' | 'toporganicscore' | 'toptraded';
export type JupInterval = '5m' | '1h' | '6h' | '24h';

const TOKENS = { source: 'jupiter-tokens', bucket: 'jupiter' } as const;
const PRICE = { source: 'jupiter-price', bucket: 'jupiter' } as const;
const STAT_KEYS: Record<Window, 'stats5m' | 'stats1h' | 'stats6h' | 'stats24h'> = {
  m5: 'stats5m',
  h1: 'stats1h',
  h6: 'stats6h',
  h24: 'stats24h',
};

export interface JupRawStats {
  priceChange?: number;
  holderChange?: number;
  liquidityChange?: number;
  volumeChange?: number;
  buyVolume?: number;
  sellVolume?: number;
  buyOrganicVolume?: number;
  sellOrganicVolume?: number;
  numBuys?: number;
  numSells?: number;
  numTraders?: number;
  numOrganicBuyers?: number;
  numNetBuyers?: number;
}

export interface JupRawToken {
  id: string;
  name: string;
  symbol: string;
  icon?: string;
  decimals?: number;
  twitter?: string;
  telegram?: string;
  website?: string;
  dev?: string;
  circSupply?: number;
  totalSupply?: number;
  tokenProgram?: string;
  launchpad?: string;
  /** Token creation time; `firstPool.createdAt` is the first pool (what `recent` sorts by). */
  createdAt?: string;
  /** Present (an address) only while the authority is still enabled and audit omits *Disabled. */
  mintAuthority?: string;
  freezeAuthority?: string;
  firstPool?: { id: string; createdAt: string };
  holderCount?: number;
  audit?: {
    mintAuthorityDisabled?: boolean;
    freezeAuthorityDisabled?: boolean;
    topHoldersPercentage?: number;
    devBalancePercentage?: number;
    devMints?: number;
    isSus?: boolean;
  };
  organicScore?: number;
  organicScoreLabel?: string;
  isVerified?: boolean;
  tags?: string[];
  fdv?: number;
  mcap?: number;
  usdPrice?: number;
  liquidity?: number;
  stats5m?: JupRawStats;
  stats1h?: JupRawStats;
  stats6h?: JupRawStats;
  stats24h?: JupRawStats;
  updatedAt?: string;
}

export interface JupRawPrice {
  usdPrice?: number;
  blockId?: number;
  decimals?: number;
  priceChange24h?: number;
  liquidity?: number;
  createdAt?: string;
}

export interface JupPrice {
  mint: string;
  usdPrice: number;
  priceChange24h: number | null;
  liquidity: number | null;
  source: 'jupiter-price';
  fetchedAt: number;
}

export interface JupTokenView {
  token: Token;
  stats: Stats;
  audit: Audit;
  /** Price/flow fields Jupiter carries, shaped as a Pair so rows survive a DexScreener outage. */
  pair: Pair;
}

export function launchpadFromJupiter(lp: string | undefined, mint: string): Launchpad {
  const s = (lp ?? '').toLowerCase();
  if (s.includes('pump')) return 'pump.fun';
  if (s.includes('bonk')) return 'bonk';
  if (s.includes('dbc') || s.includes('dynamic-bonding')) return 'dbc';
  if (s.includes('launchlab') || s.includes('raydium')) return 'raydium';
  if (s.includes('meteora')) return 'meteora';
  if (!s && mint.endsWith('pump')) return 'pump.fun';
  return 'unknown';
}

function socials(raw: JupRawToken): Socials {
  return { x: raw.twitter ?? null, tg: raw.telegram ?? null, web: raw.website ?? null };
}

function windowStats(s: JupRawStats | undefined): WindowStats | null {
  if (!s) return null;
  return {
    numTraders: numOrNull(s.numTraders),
    numNetBuyers: numOrNull(s.numNetBuyers),
    buyVol: numOrNull(s.buyOrganicVolume),
    sellVol: numOrNull(s.sellOrganicVolume),
  };
}

/** true = authority enabled. Jupiter sends `audit.*Disabled`, or omits it and sends the authority address. */
function authority(disabled: boolean | undefined, address: string | undefined): boolean | null {
  if (disabled !== undefined) return !disabled;
  if (typeof address === 'string' && address.length > 0) return true;
  return null;
}

export function normalizeJupToken(raw: JupRawToken, fetchedAt: number): JupTokenView {
  const createdAt = isoToMs(raw.firstPool?.createdAt) ?? isoToMs(raw.createdAt);
  const token: Token = {
    source: 'jupiter-tokens',
    fetchedAt,
    mint: raw.id,
    symbol: raw.symbol,
    name: raw.name,
    decimals: numOrNull(raw.decimals),
    launchpad: launchpadFromJupiter(raw.launchpad, raw.id),
    createdAt,
    image: raw.icon ?? null,
    socials: socials(raw),
    verified: raw.isVerified === true,
    // audit.isSus is only present when flagged (docs): presence is the signal.
    sus: raw.audit?.isSus !== undefined ? raw.audit.isSus !== false : false,
  };
  const perWindow = {} as ByWindow<WindowStats | null>;
  const txns = {} as Pair['txns'];
  const volume = {} as Pair['volume'];
  const priceChange = {} as Pair['priceChange'];
  for (const w of Object.keys(STAT_KEYS) as Window[]) {
    const s = raw[STAT_KEYS[w]];
    perWindow[w] = windowStats(s);
    txns[w] = { buys: num(s?.numBuys), sells: num(s?.numSells) };
    volume[w] = s && (s.buyVolume !== undefined || s.sellVolume !== undefined) ? num(s.buyVolume) + num(s.sellVolume) : null;
    priceChange[w] = numOrNull(s?.priceChange);
  }
  const stats: Stats = {
    source: 'jupiter-tokens',
    fetchedAt,
    mint: raw.id,
    holderCount: numOrNull(raw.holderCount),
    holders24hDelta: numOrNull(raw.stats24h?.holderChange),
    organicScore: numOrNull(raw.organicScore),
    perWindow,
  };
  const audit: Audit = {
    source: 'jupiter-tokens',
    fetchedAt,
    mint: raw.id,
    mintAuthority: authority(raw.audit?.mintAuthorityDisabled, raw.mintAuthority),
    freezeAuthority: authority(raw.audit?.freezeAuthorityDisabled, raw.freezeAuthority),
    // Jupiter's topHoldersPercentage (top-10 share as Jupiter computes it; SPEC §3.6 LP/CEX exclusion is not applied here).
    top10Pct: numOrNull(raw.audit?.topHoldersPercentage),
    devPct: numOrNull(raw.audit?.devBalancePercentage),
    devMints: numOrNull(raw.audit?.devMints),
    devAddress: typeof raw.dev === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw.dev) ? raw.dev : null,
    lpLockedPct: null,
    rugRisks: [],
    rugScore: null,
  };
  const pair: Pair = {
    source: 'jupiter-tokens',
    fetchedAt,
    pairAddress: raw.firstPool?.id ?? '',
    dex: 'unknown',
    baseMint: raw.id,
    quoteMint: '',
    priceUsd: num(raw.usdPrice),
    priceNative: 0,
    liquidityUsd: numOrNull(raw.liquidity),
    fdv: numOrNull(raw.fdv),
    mcap: numOrNull(raw.mcap),
    txns,
    volume,
    priceChange,
    createdAt,
  };
  return { token, stats, audit, pair };
}

export class Jupiter {
  private readonly http: HttpClient;
  private readonly hosts: readonly string[];
  private hostIndex = 0;

  constructor(http: HttpClient, hosts: readonly string[] = JUPITER_HOSTS) {
    this.http = http;
    this.hosts = hosts;
  }

  get host(): string {
    return this.hosts[this.hostIndex];
  }

  /** Search by mint list (batched ≤100), symbol or name. */
  async search(query: string | string[]): Promise<JupTokenView[]> {
    const queries = Array.isArray(query) ? chunk([...new Set(query)], JUP_SEARCH_BATCH).map((b) => b.join(',')) : [query];
    const out: JupTokenView[] = [];
    for (const q of queries) {
      const r = await this.get<JupRawToken[]>(`/tokens/v2/search?query=${encodeURIComponent(q)}`, TOKENS);
      for (const t of Array.isArray(r.data) ? r.data : []) out.push(normalizeJupToken(t, r.fetchedAt));
    }
    return out;
  }

  /** Newest tokens by first-pool creation time (default 30). */
  async recent(): Promise<JupTokenView[]> {
    return this.list('/tokens/v2/recent');
  }

  async category(category: JupCategory, interval: JupInterval, limit?: number): Promise<JupTokenView[]> {
    return this.list(`/tokens/v2/${category}/${interval}${limit ? `?limit=${limit}` : ''}`);
  }

  /** USD prices for up to N mints, batched 50 per call. Unknown mints are absent. */
  async price(mints: string[]): Promise<Map<string, JupPrice>> {
    const out = new Map<string, JupPrice>();
    for (const batch of chunk([...new Set(mints)], JUP_PRICE_BATCH)) {
      const r = await this.get<Record<string, JupRawPrice | null>>(`/price/v3?ids=${batch.join(',')}`, PRICE);
      for (const [mint, p] of Object.entries(r.data ?? {})) {
        if (!p || numOrNull(p.usdPrice) === null) continue;
        out.set(mint, {
          mint,
          usdPrice: num(p.usdPrice),
          priceChange24h: numOrNull(p.priceChange24h),
          liquidity: numOrNull(p.liquidity),
          source: 'jupiter-price',
          fetchedAt: r.fetchedAt,
        });
      }
    }
    return out;
  }

  private async list(path: string): Promise<JupTokenView[]> {
    const r = await this.get<JupRawToken[]>(path, TOKENS);
    return (Array.isArray(r.data) ? r.data : []).map((t) => normalizeJupToken(t, r.fetchedAt));
  }

  private async get<T>(path: string, meta: typeof TOKENS | typeof PRICE): Promise<JsonResult<T>> {
    for (;;) {
      try {
        return await this.http.getJson<T>(`${this.host}${path}`, meta);
      } catch (err) {
        const refused = err instanceof HttpError && (err.status === 401 || err.status === 403);
        if (!refused || this.hostIndex >= this.hosts.length - 1) throw err;
        this.hostIndex++; // sticky for the session
      }
    }
  }
}
