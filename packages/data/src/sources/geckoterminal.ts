// GeckoTerminal adapter (SPEC §3.1 S4). Keyless, read-only, 10 calls/min.
// Docs: solana-launchpad/docs/geckoterminal-api/{api-page,overview}.md.
//   GET /networks/solana/pools/{pool}/ohlcv/{minute|hour|day}?aggregate=&limit=&currency=usd[&token=]
//       -> data.attributes.ohlcv_list: [[unix_s, o, h, l, c, volume_usd], ...] newest first;
//          bars with no trades are omitted (gaps are normal).
//   GET /networks/solana/tokens/{mint}/pools?page=1 -> top pools for a mint (to find the pool
//       to chart when the caller has no DexScreener pair address).
// Closed-bar caching and the refresh budget live in ../candles.ts.

import type { HttpClient } from '../http.ts';
import type { Candle, CandleInterval, Trade } from '../model.ts';
import { isoToMs, num, numOrNull } from '../util.ts';

export const GECKOTERMINAL_BASE = 'https://api.geckoterminal.com/api/v2';
const NETWORK = 'solana';
const META = { source: 'geckoterminal', bucket: 'geckoterminal' } as const;
/** Documented max `limit` for the OHLCV endpoint. */
export const GT_MAX_LIMIT = 1000;

export interface TimeframeSpec {
  timeframe: 'minute' | 'hour' | 'day';
  aggregate: number;
  periodMs: number;
}

/** SPEC §4.3 timeframe tabs -> GeckoTerminal timeframe + aggregate (minute 1/5/15, hour 1/4/12, day 1). */
export const CANDLE_TIMEFRAMES: Record<CandleInterval, TimeframeSpec> = {
  '1m': { timeframe: 'minute', aggregate: 1, periodMs: 60_000 },
  '5m': { timeframe: 'minute', aggregate: 5, periodMs: 300_000 },
  '15m': { timeframe: 'minute', aggregate: 15, periodMs: 900_000 },
  '1h': { timeframe: 'hour', aggregate: 1, periodMs: 3_600_000 },
  '4h': { timeframe: 'hour', aggregate: 4, periodMs: 14_400_000 },
  '1d': { timeframe: 'day', aggregate: 1, periodMs: 86_400_000 },
};
export const CANDLE_INTERVALS = Object.keys(CANDLE_TIMEFRAMES) as CandleInterval[];

export interface GtRawOhlcv {
  data?: { id?: string; type?: string; attributes?: { ohlcv_list?: unknown[][] } };
  meta?: { base?: GtRawTokenRef; quote?: GtRawTokenRef };
}

export interface GtRawTokenRef {
  address?: string;
  name?: string;
  symbol?: string;
}

export interface GtRawPool {
  id: string;
  type?: string;
  attributes?: {
    address?: string;
    name?: string;
    pool_created_at?: string;
    reserve_in_usd?: string;
    base_token_price_usd?: string;
    volume_usd?: { h24?: string };
  };
  relationships?: {
    base_token?: { data?: { id?: string } };
    quote_token?: { data?: { id?: string } };
    dex?: { data?: { id?: string } };
  };
}

/** `/pools/{pool}/trades` row (last 300 trades, keyless, same 10/min bucket). */
export interface GtRawTrade {
  id?: string;
  type?: string;
  attributes?: {
    block_number?: number;
    tx_hash?: string;
    tx_from_address?: string;
    from_token_amount?: string;
    to_token_amount?: string;
    price_from_in_currency_token?: string;
    price_to_in_currency_token?: string;
    price_from_in_usd?: string;
    price_to_in_usd?: string;
    block_timestamp?: string;
    kind?: string;
    volume_in_usd?: string;
    from_token_address?: string;
    to_token_address?: string;
  };
}

export interface GtTrade extends Trade {
  signature: string | null;
  block: number | null;
}

export interface OhlcvResult {
  pool: string;
  interval: CandleInterval;
  /** Oldest first. The newest bar may still be open. */
  candles: Candle[];
  base: { address: string; symbol: string } | null;
  quote: { address: string; symbol: string } | null;
  source: 'geckoterminal';
  fetchedAt: number;
}

export interface GtPool {
  address: string;
  name: string;
  dex: string;
  baseMint: string | null;
  quoteMint: string | null;
  reserveUsd: number | null;
  volume24hUsd: number | null;
  createdAt: number | null;
  source: 'geckoterminal';
  fetchedAt: number;
}

export interface OhlcvOptions {
  /** Bars to request (1..1000, default 100). */
  limit?: number;
  /** Price the candles in this token of the pool (mint address); default is the pool's base token. */
  token?: string;
}

/** `[[unix_s, o, h, l, c, v], ...]` (any order) -> Candle[] oldest first, malformed rows dropped. */
export function parseOhlcvList(list: unknown[][] | undefined): Candle[] {
  const out: Candle[] = [];
  for (const row of list ?? []) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [t, o, h, l, c, v] = row.map((x) => numOrNull(x));
    if (t === null || o === null || h === null || l === null || c === null) continue;
    out.push({ t: t * 1000, o, h, l, c, v: v ?? 0 });
  }
  out.sort((a, b) => a.t - b.t);
  // GT never returns two bars for one timestamp; keep the last if it ever does.
  return out.filter((b, i) => i === out.length - 1 || out[i + 1].t !== b.t);
}

/** Raw trade rows -> Trade[] newest first; rows without a timestamp or amount are dropped. */
export function parseTrades(rows: GtRawTrade[], mint?: string): GtTrade[] {
  const out: GtTrade[] = [];
  for (const row of rows) {
    const a = row?.attributes;
    if (!a) continue;
    const t = isoToMs(a.block_timestamp);
    if (t === null) continue;
    const toMint = a.to_token_address;
    const fromMint = a.from_token_address;
    let side: Trade['side'];
    let price: number | null;
    if (mint && (toMint === mint || fromMint === mint)) {
      side = toMint === mint ? 'buy' : 'sell';
      price = numOrNull(side === 'buy' ? a.price_to_in_usd : a.price_from_in_usd);
    } else {
      side = a.kind === 'sell' ? 'sell' : 'buy';
      price = numOrNull(side === 'buy' ? a.price_to_in_usd : a.price_from_in_usd);
    }
    const usd = numOrNull(a.volume_in_usd);
    if (usd === null) continue;
    out.push({ t, side, usd, price: price ?? 0, wallet: a.tx_from_address ?? '', signature: a.tx_hash ?? null, block: numOrNull(a.block_number) });
  }
  out.sort((x, y) => y.t - x.t);
  return out;
}

/** "solana_<address>" -> "<address>". */
function stripNetwork(id: string | undefined): string | null {
  if (!id) return null;
  const i = id.indexOf('_');
  return i >= 0 ? id.slice(i + 1) : id;
}

export class GeckoTerminal {
  private readonly http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }

  static ohlcvUrl(pool: string, interval: CandleInterval, opts: OhlcvOptions = {}): string {
    const tf = CANDLE_TIMEFRAMES[interval];
    if (!tf) throw new Error(`unknown candle interval: ${interval}`);
    const limit = Math.max(1, Math.min(GT_MAX_LIMIT, Math.floor(opts.limit ?? 100)));
    const q = new URLSearchParams({ aggregate: String(tf.aggregate), limit: String(limit), currency: 'usd' });
    if (opts.token) q.set('token', opts.token);
    return `${GECKOTERMINAL_BASE}/networks/${NETWORK}/pools/${encodeURIComponent(pool)}/ohlcv/${tf.timeframe}?${q}`;
  }

  async ohlcv(pool: string, interval: CandleInterval, opts: OhlcvOptions = {}): Promise<OhlcvResult> {
    const r = await this.http.getJson<GtRawOhlcv>(GeckoTerminal.ohlcvUrl(pool, interval, opts), META);
    const ref = (x: GtRawTokenRef | undefined) => (x?.address ? { address: x.address, symbol: x.symbol ?? '' } : null);
    return {
      pool,
      interval,
      candles: parseOhlcvList(r.data.data?.attributes?.ohlcv_list),
      base: ref(r.data.meta?.base),
      quote: ref(r.data.meta?.quote),
      source: 'geckoterminal',
      fetchedAt: r.fetchedAt,
    };
  }

  /**
   * Recent trades of a pool, newest first (GeckoTerminal keeps the last 300). `mint` decides the side
   * (receiving the mint = buy) and which USD price is the token's; without it GeckoTerminal's `kind` is used.
   */
  async trades(pool: string, opts: { mint?: string; minUsd?: number } = {}): Promise<{ trades: GtTrade[]; fetchedAt: number }> {
    const q = opts.minUsd ? `?trade_volume_in_usd_greater_than=${encodeURIComponent(String(opts.minUsd))}` : '';
    const url = `${GECKOTERMINAL_BASE}/networks/${NETWORK}/pools/${encodeURIComponent(pool)}/trades${q}`;
    const r = await this.http.getJson<{ data?: GtRawTrade[] }>(url, META);
    return { trades: parseTrades(r.data.data ?? [], opts.mint), fetchedAt: r.fetchedAt };
  }

  /** Top pools for a mint, most liquid first. */
  async tokenPools(mint: string): Promise<GtPool[]> {
    const url = `${GECKOTERMINAL_BASE}/networks/${NETWORK}/tokens/${encodeURIComponent(mint)}/pools?page=1`;
    const r = await this.http.getJson<{ data?: GtRawPool[] }>(url, META);
    const pools = (r.data.data ?? []).map((p): GtPool => ({
      address: p.attributes?.address ?? stripNetwork(p.id) ?? '',
      name: p.attributes?.name ?? '',
      dex: stripNetwork(p.relationships?.dex?.data?.id) ?? p.relationships?.dex?.data?.id ?? 'unknown',
      baseMint: stripNetwork(p.relationships?.base_token?.data?.id),
      quoteMint: stripNetwork(p.relationships?.quote_token?.data?.id),
      reserveUsd: numOrNull(p.attributes?.reserve_in_usd),
      volume24hUsd: numOrNull(p.attributes?.volume_usd?.h24),
      createdAt: isoToMs(p.attributes?.pool_created_at),
      source: 'geckoterminal',
      fetchedAt: r.fetchedAt,
    }));
    return pools.filter((p) => p.address).sort((a, b) => num(b.reserveUsd) - num(a.reserveUsd));
  }
}
