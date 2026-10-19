// Token-detail data (SPEC §4.3, D-06): candles, on-chain authorities, top-20
// holders and the RugCheck summary, each cached with its SPEC §3.4 TTL and
// stale-while-revalidate, so the detail screen and the MCP tools share one
// set of requests.

import type { Cache, FetchResult } from './cache.ts';
import { TTL } from './cache.ts';
import type { CandleRequest, CandleSeries, CandleStore } from './candles.ts';
import { DEFAULT_CANDLE_LIMIT, MAX_KEPT_BARS } from './candles.ts';
import type { Clock } from './clock.ts';
import { systemClock } from './clock.ts';
import type { HealthRegistry } from './health.ts';
import type { CandleInterval } from './model.ts';
import { CANDLE_TIMEFRAMES } from './sources/geckoterminal.ts';
import { bucketShrineRows, SHRINE_MIN_BARS, SHRINE_SIDE_STALE_MS, type Shrine, type ShrineHistory } from './sources/shrine.ts';
import type { RpcPool } from './rpc-pool.ts';
import type { GeckoTerminal, GtPool, GtTrade } from './sources/geckoterminal.ts';
import type { GoPlus, GoPlusSecurity } from './sources/goplus.ts';
import type { RugCheck, RugSummary } from './sources/rugcheck.ts';
import type { SolanaTracker, TrackerRisk } from './sources/solanatracker.ts';
import type { MintInfo, TopHolders } from './sources/solana-rpc.ts';

/**
 * Keyless aggregate holder data (task-1309): holder count + top-10 concentration from a source that
 * answers without a key (Jupiter). Used only when the RPC pool cannot serve the ranked top-20 list.
 */
export interface HoldersAggregate {
  holderCount: number | null;
  top10Pct: number | null;
  source: 'jupiter-tokens';
  fetchedAt: number;
}

const NS = { mint: 'rpc:mint', holders: 'rpc:holders', rug: 'rugcheck', pools: 'gt:pools', goplus: 'goplus', trades: 'gt:trades', tracker: 'solanatracker', shrine: 'shrine:history' } as const;
/** Pools for a mint change rarely; one lookup per hour per mint. */
const POOLS_TTL = 3_600_000;
/** The trades tape shares GeckoTerminal's 10/min bucket with the candles: refresh at most every 20 s per pool. */
export const TRADES_TTL = 20_000;

export class TokenDetail {
  private readonly cache: Cache;
  private readonly gecko: GeckoTerminal;
  /** RPC pool: rotates across keyed + keyless endpoints with health scoring and 429 backoff (task-1309). */
  private readonly pool: RpcPool;
  /** Keyless holder aggregate (Jupiter) used when no RPC endpoint can serve the ranked list. */
  private readonly holdersAggregate: ((mint: string) => Promise<HoldersAggregate | null>) | null;
  private readonly rug: RugCheck;
  private readonly goplus: GoPlus | null;
  private readonly tracker: SolanaTracker | null;
  /** Keyed 1 s candle source; null without a Shrine key. */
  private readonly shrine: Shrine | null;
  private readonly health: HealthRegistry | null;
  private readonly clock: Clock;
  readonly candleStore: CandleStore;

  constructor(deps: {
    cache: Cache;
    gecko: GeckoTerminal;
    pool: RpcPool;
    holdersAggregate?: ((mint: string) => Promise<HoldersAggregate | null>) | null;
    rugcheck: RugCheck;
    goplus?: GoPlus | null;
    tracker?: SolanaTracker | null;
    candles: CandleStore;
    shrine?: Shrine | null;
    health?: HealthRegistry | null;
    clock?: Clock;
  }) {
    this.cache = deps.cache;
    this.gecko = deps.gecko;
    this.pool = deps.pool;
    this.holdersAggregate = deps.holdersAggregate ?? null;
    this.rug = deps.rugcheck;
    this.goplus = deps.goplus ?? null;
    this.tracker = deps.tracker ?? null;
    this.shrine = deps.shrine ?? null;
    this.health = deps.health ?? null;
    this.clock = deps.clock ?? systemClock;
    this.candleStore = deps.candles;
  }

  /** True when a Shrine key is configured (1 s candles by mint, no pool needed). */
  get hasShrine(): boolean { return this.shrine !== null; }

  /**
   * Candles for a pool (pass DexScreener's `pair.pairAddress` to avoid a pool lookup). With a Shrine key and
   * `req.token` (the mint), Shrine serves first: its newest 500 one-second rows bucketed to `interval`.
   * GeckoTerminal answers instead when Shrine fails (any error, degraded health, an unpriceable pool), or
   * when Shrine's window is thinner than SHRINE_MIN_BARS bars or charts a different pool than `pool` and
   * GeckoTerminal has at least as many bars. `source` says which.
   * `pool` may be empty when only Shrine is wanted (a mint with no indexed pair yet).
   */
  async candles(pool: string, interval: CandleInterval, req: CandleRequest = {}): Promise<CandleSeries> {
    const mint = req.token;
    if (!this.shrine || !mint || (this.health && !this.health.isAvailable('shrine'))) return this.geckoCandles(pool, interval, req);
    let shrine: CandleSeries | null = null;
    let shrineErr: unknown = null;
    let lastRowT = 0;
    try {
      const h = await this.shrineHistory(mint);
      lastRowT = h.value.rows[h.value.rows.length - 1]?.t ?? 0;
      shrine = this.shrineSeries(h, interval, req);
    } catch (err) {
      shrineErr = err;
    }
    const limit = Math.max(1, Math.min(MAX_KEPT_BARS, Math.floor(req.limit ?? DEFAULT_CANDLE_LIMIT)));
    // Shrine leads when it charts the screen's own pool (or there is none yet) with a usable window. For
    // an older coin it often charts a side pool with a few sparse rows (WIF, BONK on 2026-10-18), so then
    // GeckoTerminal's main pool answers whenever it has at least as many bars. A side pool that has not
    // traded for an hour is never shown: HMYd...pump's last side-pool print sat 72% off its market.
    const primary = !pool || shrine?.pool === pool;
    if (shrine && !primary && this.clock.now() - lastRowT > SHRINE_SIDE_STALE_MS) {
      shrine = null;
      shrineErr = new Error('shrine: side pool stale');
    }
    if (shrine && primary && shrine.candles.length >= Math.min(limit, SHRINE_MIN_BARS)) return shrine;
    try {
      const g = await this.geckoCandles(pool, interval, req);
      if (!shrine || g.candles.length >= shrine.candles.length) return g;
    } catch (err) {
      if (!shrine) throw pool ? err : shrineErr ?? err;
    }
    return shrine!;
  }

  private geckoCandles(pool: string, interval: CandleInterval, req: CandleRequest): Promise<CandleSeries> {
    if (!pool) return Promise.reject(new Error('no pool found for this mint'));
    return this.candleStore.get(pool, interval, req);
  }

  /** Shrine's validated USD 1 s history for a mint (TTL 10 s, stale-while-revalidate). Throws without a key. */
  shrineHistory(mint: string): Promise<FetchResult<ShrineHistory>> {
    const sh = this.shrine;
    if (!sh) return Promise.reject(new Error('shrine: no key configured'));
    return this.cache.fetch(NS.shrine, mint, () => sh.history(mint), { ttlMs: TTL.shrine, source: 'shrine' });
  }

  private shrineSeries(h: FetchResult<ShrineHistory>, interval: CandleInterval, req: CandleRequest): CandleSeries {
    const { periodMs } = CANDLE_TIMEFRAMES[interval];
    const limit = Math.max(1, Math.min(MAX_KEPT_BARS, Math.floor(req.limit ?? DEFAULT_CANDLE_LIMIT)));
    const candles = bucketShrineRows(h.value.rows, periodMs).slice(-limit);
    const last = candles[candles.length - 1];
    const open = last && last.t + periodMs > this.clock.now() ? last.t : null;
    return {
      pool: h.value.pool,
      interval,
      candles,
      openBarT: open,
      source: 'shrine',
      basis: { quoteMint: h.value.quoteMint, quoteUsd: h.value.quoteUsd, quoteSource: h.value.quoteSource, adjusted: h.value.adjusted, capped: h.value.capped },
      fetchedAt: h.fetchedAt,
      fromCache: h.fromCache,
      stale: h.stale,
      ...(h.error ? { error: h.error } : {}),
      ...(h.refreshing ? { refreshing: h.refreshing } : {}),
    };
  }

  /** Most liquid GeckoTerminal pool for a mint (one request per hour per mint). */
  async topPool(mint: string): Promise<GtPool | null> {
    const r = await this.cache.fetch<GtPool[]>(NS.pools, mint, () => this.gecko.tokenPools(mint), { ttlMs: POOLS_TTL, source: 'geckoterminal' });
    return r.value[0] ?? null;
  }

  /** Mint/freeze authority truth from chain (TTL audit, 10 min). RPC pool: keyed endpoints first, keyless public RPC rotation behind them. */
  mintInfo(mint: string): Promise<FetchResult<MintInfo>> {
    return this.cache.fetch(NS.mint, mint, () => this.pool.mintInfo(mint), { ttlMs: TTL.audit, source: this.pool.primary.source });
  }

  /**
   * Top-20 holders (TTL holders, 60 s); reuses the cached mint info for supply/decimals. The RPC pool
   * rotates across every endpoint; the result's `source` says which answered. When no endpoint can serve
   * the ranked list (keyless: getTokenLargestAccounts is throttled/blocked everywhere), fall back to the
   * Jupiter aggregate (`aggregateOnly`: holder count + top-10 share, empty list). Only when that also fails
   * does the RPC error propagate, so the caller shows "unavailable".
   */
  async holders(mint: string): Promise<FetchResult<TopHolders>> {
    return this.cache.fetch(
      NS.holders,
      mint,
      async () => {
        const info = (await this.mintInfo(mint)).value;
        try {
          return await this.pool.topHolders(mint, { info });
        } catch (rpcErr) {
          const agg = await this.aggregateHolders(mint, info).catch(() => null);
          if (agg) return agg;
          throw rpcErr;
        }
      },
      { ttlMs: TTL.holders, source: this.pool.primary.source },
    );
  }

  /** Build an aggregate-only TopHolders from the keyless Jupiter holder data; null when unavailable. */
  private async aggregateHolders(mint: string, info: MintInfo): Promise<TopHolders | null> {
    if (!this.holdersAggregate) return null;
    const a = await this.holdersAggregate(mint);
    if (!a || (a.holderCount === null && a.top10Pct === null)) return null;
    return {
      mint,
      holders: [],
      top10Pct: a.top10Pct,
      supply: info.supply,
      decimals: info.decimals,
      source: a.source,
      fetchedAt: a.fetchedAt,
      aggregateOnly: true,
      holderCount: a.holderCount,
    };
  }

  rugcheck(mint: string): Promise<FetchResult<RugSummary>> {
    return this.cache.fetch(NS.rug, mint, () => this.rug.summary(mint), { ttlMs: TTL.rugcheck, source: 'rugcheck' });
  }

  /** GoPlus second opinion (TTL rugcheck, 10 min). Throws when the adapter is not configured. */
  security(mint: string): Promise<FetchResult<GoPlusSecurity>> {
    const gp = this.goplus;
    if (!gp) throw new Error('goplus adapter not configured');
    return this.cache.fetch(NS.goplus, mint, () => gp.tokenSecurity(mint), { ttlMs: TTL.rugcheck, source: 'goplus' });
  }

  /** True when a Solana Tracker key is configured (the keyed risk read is available). */
  get hasTracker(): boolean { return this.tracker !== null; }

  /** Solana Tracker risk read (TTL 2 min). Throws when no key is configured: check hasTracker first. */
  trackerRisk(mint: string): Promise<FetchResult<TrackerRisk>> {
    const st = this.tracker;
    if (!st) throw new Error('solanatracker: no key configured');
    return this.cache.fetch(NS.tracker, mint, () => st.token(mint), { ttlMs: TTL.tracker, source: 'solanatracker' });
  }

  /** Recent trades of the token's pool from GeckoTerminal (best keyless tape), newest first, 20 s TTL. */
  trades(pool: string, mint?: string): Promise<FetchResult<GtTrade[]>> {
    return this.cache.fetch(NS.trades, `${pool}:${mint ?? ''}`, async () => (await this.gecko.trades(pool, { mint })).trades, { ttlMs: TRADES_TTL, source: 'geckoterminal' });
  }
}
