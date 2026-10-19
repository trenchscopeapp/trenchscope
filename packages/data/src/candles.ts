// Candle store (SPEC §3.4): GeckoTerminal OHLCV with closed-bar caching.
//
// Two cache rows per (pool, interval, token):
//   candles:closed  bars whose period has ended. They do not change, so they are
//                   kept for TTL.candlesClosed (1 h) and only re-verified by a full
//                   fetch after that.
//   candles:view    the last served series (closed + the open bar), TTL.candlesOpen
//                   (30 s). Within that window a request costs nothing.
// When the view expires, a refresh asks GeckoTerminal only for the bars missing
// since the last closed bar plus the open one (usually limit=2), merges them into
// the closed set and re-splits on the clock. Every request goes through the
// HttpClient, so the geckoterminal bucket (10 rpm x 0.7) is never exceeded and
// identical concurrent loads share one request.

import type { Cache } from './cache.ts';
import { TTL } from './cache.ts';
import type { Clock } from './clock.ts';
import type { Candle, CandleInterval } from './model.ts';
import { CANDLE_TIMEFRAMES, GT_MAX_LIMIT } from './sources/geckoterminal.ts';
import type { GeckoTerminal } from './sources/geckoterminal.ts';
import { currentPriority, withPriority } from './http.ts';
import { PriorityRef } from './limiter.ts';

const NS_CLOSED = 'candles:closed';
const NS_VIEW = 'candles:view';
/** Closed bars kept per series (GeckoTerminal's max page). */
export const MAX_KEPT_BARS = GT_MAX_LIMIT;
/** Default bars per series: enough for the widest chart (SPEC §5.2 caps the AI tool at 300). */
export const DEFAULT_CANDLE_LIMIT = 300;

/**
 * task-1314: the coarser timeframes derive exactly from a finer base, so two network fetches (1m, 1h)
 * cover all six tabs and a timeframe switch paints instantly from local aggregation. Each target period
 * is an integer multiple of its base and every trenchscope period divides the epoch evenly (minute/hour/day
 * all start at a UTC boundary = floor(t/period)*period), so the derived buckets line up with the bars
 * GeckoTerminal would return natively. 1m and 1h are the base intervals (not derivable).
 */
export const CANDLE_BASE: Partial<Record<CandleInterval, CandleInterval>> = {
  '5m': '1m',
  '15m': '1m',
  '4h': '1h',
  '1d': '1h',
};
/** Base intervals that must be fetched from the network; every other tab derives from one of these. */
export const CANDLE_BASE_INTERVALS: CandleInterval[] = ['1m', '1h'];

/**
 * Aggregate oldest-first base candles into a coarser interval by exact period multiple. Returns `[]`
 * when `toPeriodMs` is not a positive integer multiple of `fromPeriodMs` (the caller then fetches
 * natively). Buckets align to `floor(t/toPeriodMs)*toPeriodMs`; gaps (GeckoTerminal omits empty bars)
 * stay gaps. open = first sub-bar's open, close = last sub-bar's close, high/low = extremes, v = sum.
 */
export function aggregateCandles(base: Candle[], fromPeriodMs: number, toPeriodMs: number): Candle[] {
  if (fromPeriodMs <= 0 || toPeriodMs <= fromPeriodMs || toPeriodMs % fromPeriodMs !== 0) return [];
  if (base.length === 0) return [];
  const sorted = base.every((b, i) => i === 0 || b.t >= base[i - 1].t) ? base : [...base].sort((a, b) => a.t - b.t);
  const buckets = new Map<number, Candle>();
  for (const b of sorted) {
    const t = Math.floor(b.t / toPeriodMs) * toPeriodMs;
    const cur = buckets.get(t);
    if (!cur) {
      buckets.set(t, { t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c; // sorted oldest-first: the last write is the latest close
      cur.v += b.v;
    }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

export interface CandleSeries {
  pool: string;
  interval: CandleInterval;
  /** Oldest first; at most `limit`. The last bar is open when `openBarT` equals its `t`. */
  candles: Candle[];
  openBarT: number | null;
  /** Which source served the bars: Shrine (keyed, 1 s rows bucketed) or GeckoTerminal. */
  source: 'geckoterminal' | 'shrine';
  /**
   * Shrine only: how the quote-token rows became USD. `quoteUsd` is the current rate applied to the whole
   * window (not historical FX); `adjusted` names a PumpSwap virtual-reserve repricing.
   */
  basis?: { quoteMint: string; quoteUsd: number; quoteSource: 'jupiter-price' | 'shrine'; adjusted: 'pumpswap-virtual-reserves' | null; capped: boolean };
  fetchedAt: number;
  fromCache: boolean;
  stale: boolean;
  /** Set when a refresh failed and the cached series was served instead. */
  error?: Error;
  /** Background refresh (stale-while-revalidate); resolves when it settles. */
  refreshing?: Promise<void>;
}

export interface CandleRequest {
  limit?: number;
  /** Price in this token of the pool (mint). */
  token?: string;
  /** Serve an expired view immediately and refresh in the background (default true). */
  swr?: boolean;
}

interface View {
  candles: Candle[];
  openBarT: number | null;
  limit: number;
}

export class CandleStore {
  private readonly cache: Cache;
  private readonly gecko: GeckoTerminal;
  private readonly clock: Clock;
  private readonly inflight = new Map<string, { p: Promise<View>; ref: PriorityRef }>();

  constructor(deps: { cache: Cache; gecko: GeckoTerminal; clock: Clock }) {
    this.cache = deps.cache;
    this.gecko = deps.gecko;
    this.clock = deps.clock;
  }

  async get(pool: string, interval: CandleInterval, req: CandleRequest = {}): Promise<CandleSeries> {
    const limit = Math.max(1, Math.min(MAX_KEPT_BARS, Math.floor(req.limit ?? DEFAULT_CANDLE_LIMIT)));
    const key = `${pool}:${interval}:${req.token ?? ''}`;
    const hit = this.cache.get<View>(NS_VIEW, key);
    const usable = hit && hit.value.limit >= limit ? hit : undefined;
    const series = (v: View, fetchedAt: number, extra: Partial<CandleSeries>): CandleSeries => ({
      pool,
      interval,
      candles: v.candles.slice(-limit),
      openBarT: v.openBarT,
      source: 'geckoterminal' as const,
      fetchedAt,
      fromCache: false,
      stale: false,
      ...extra,
    });
    if (usable && !usable.stale) return series(usable.value, usable.fetchedAt, { fromCache: true });
    if (usable && (req.swr ?? true)) {
      // The caller already has something to paint: the revalidation is background work (task-1323),
      // so it never takes the bucket's foreground reserve away from a chart that is actually empty.
      const refreshing = withPriority('low', () => this.load(key, pool, interval, limit, req.token)).then(
        () => undefined,
        () => undefined,
      );
      return series(usable.value, usable.fetchedAt, { fromCache: true, stale: true, refreshing });
    }
    try {
      const v = await this.load(key, pool, interval, limit, req.token);
      return series(v, this.clock.now(), {});
    } catch (err) {
      if (!usable) throw err;
      return series(usable.value, usable.fetchedAt, { fromCache: true, stale: true, error: err as Error });
    }
  }

  /**
   * Coalesced refresh: identical concurrent loads share one request. Each load runs under its own
   * priority ref (task-1323); a more urgent caller joining a queued background load raises it, so a
   * prefetch already waiting in the GeckoTerminal bucket cannot hold a foreground chart back.
   */
  private load(key: string, pool: string, interval: CandleInterval, limit: number, token: string | undefined): Promise<View> {
    const caller = currentPriority();
    const existing = this.inflight.get(key);
    if (existing) {
      if (caller) existing.ref.raise(caller.level);
      return existing.p;
    }
    const ref = new PriorityRef(caller?.level ?? 'normal');
    const p = withPriority(ref, () => this.refresh(key, pool, interval, limit, token)).finally(() => this.inflight.delete(key));
    this.inflight.set(key, { p, ref });
    return p;
  }

  /** True when a usable series for (pool, interval, token) is cached (fresh or stale) at >= `limit` bars. */
  has(pool: string, interval: CandleInterval, req: { limit?: number; token?: string } = {}): boolean {
    const limit = Math.max(1, Math.min(MAX_KEPT_BARS, Math.floor(req.limit ?? DEFAULT_CANDLE_LIMIT)));
    const hit = this.cache.get<View>(NS_VIEW, `${pool}:${interval}:${req.token ?? ''}`);
    return !!hit && hit.value.limit >= limit && hit.value.candles.length > 0;
  }

  private async refresh(key: string, pool: string, interval: CandleInterval, limit: number, token: string | undefined): Promise<View> {
    const { periodMs } = CANDLE_TIMEFRAMES[interval];
    const closed = this.cache.get<Candle[]>(NS_CLOSED, key);
    const reuse = closed && !closed.stale && closed.value.length > 0 ? closed : undefined;

    let fetchLimit = limit;
    if (reuse) {
      const last = reuse.value[reuse.value.length - 1].t;
      // Bars that can have appeared since the last closed one, plus the open bar.
      const missing = Math.ceil((this.clock.now() - last) / periodMs) + 1;
      const have = reuse.value.length;
      // Incremental only if the kept history already covers the requested depth.
      if (have + missing >= limit || have >= MAX_KEPT_BARS) fetchLimit = Math.min(limit, Math.max(2, missing));
    }

    const res = await this.gecko.ohlcv(pool, interval, { limit: fetchLimit, token });
    const now = this.clock.now();
    const merged = new Map<number, Candle>();
    if (reuse && fetchLimit < limit) for (const b of reuse.value) merged.set(b.t, b);
    for (const b of res.candles) merged.set(b.t, b);
    const bars = [...merged.values()].sort((a, b) => a.t - b.t);

    const closedBars = bars.filter((b) => b.t + periodMs <= now).slice(-MAX_KEPT_BARS);
    const open = bars.find((b) => b.t + periodMs > now) ?? null;
    // An incremental merge keeps the original fetchedAt, so closed bars are still
    // fully re-verified once an hour (GeckoTerminal occasionally revises late trades).
    const closedFetchedAt = reuse && fetchLimit < limit ? reuse.fetchedAt : now;
    this.cache.set(NS_CLOSED, key, closedBars, { ttlMs: TTL.candlesClosed, source: 'geckoterminal', fetchedAt: closedFetchedAt });

    const view: View = { candles: open ? [...closedBars, open] : closedBars, openBarT: open?.t ?? null, limit };
    this.cache.set(NS_VIEW, key, view, { ttlMs: TTL.candlesOpen, source: 'geckoterminal' });
    return view;
  }
}
