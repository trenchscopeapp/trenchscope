// The data layer factory (createDataLayer), moved out of the package barrel (index.ts) so a read-only
// consumer can build the live data layer without loading the trade / signer modules the barrel also
// re-exports. index.ts re-exports everything here, so `@dexterm/data` is unchanged for every caller;
// `@dexterm/data/core` (core.ts) is the narrow, trade-free entry (the paper bot's import guard relies on it).

import { Cache, TTL } from './cache.ts';
import type { Clock } from './clock.ts';
import { systemClock } from './clock.ts';
import { HealthRegistry } from './health.ts';
import type { RequestMeta, HttpRequest, Transport } from './http.ts';
import { HttpClient, liveTransport } from './http.ts';
import type { BucketConfig } from './limiter.ts';
import { DEFAULT_BUCKETS, RateLimiter, SOURCE_BUCKET } from './limiter.ts';
import type { SourceId } from './model.ts';
import { DexScreener } from './sources/dexscreener.ts';
import { Jupiter } from './sources/jupiter.ts';
import { JupiterSwap } from './sources/jupiter-swap.ts';
import { GeckoTerminal } from './sources/geckoterminal.ts';
import { RugCheck } from './sources/rugcheck.ts';
import { SolanaTracker } from './sources/solanatracker.ts';
import { GoPlus } from './sources/goplus.ts';
import { Shrine } from './sources/shrine.ts';
// Wrapped SOL (same constant as trade/tx-decode.ts WSOL_MINT; taken from the paper ledger so no trade module loads).
import { SOL_MINT as WSOL_MINT } from './paper.ts';
import type { ShrineSocketOptions } from './sources/shrine-socket.ts';
import { SOLANA_PUBLIC_RPC, SolanaRpc } from './sources/solana-rpc.ts';
import { CandleStore } from './candles.ts';
import { TokenDetail, type HoldersAggregate } from './detail.ts';
import { Store } from './store.ts';
import { HELIUS_RPC_HOST, PUBLIC_RPC_POOL } from './rpc-config.ts';
import { RpcPool, type RpcEndpointSpec, bucketFor } from './rpc-pool.ts';
import { CreditMeter, type CreditMeterOptions } from './credits.ts';
import { BudgetMeter, type BudgetMeterOptions } from './budget.ts';

export interface DataLayerOptions {
  /** SQLite path; default in-memory. Use defaultDbPath() for the XDG location. */
  dbPath?: string;
  /** Default: live keyless fetch. Tests pass replayTransport(). */
  transport?: Transport;
  /**
   * Shutdown controller whose signal close() aborts (task-1319). When the caller builds its own
   * `transport` (createLiveFeed does), it must build that transport with THIS controller's signal so
   * close() actually aborts the in-flight fetch; otherwise the default live transport is wired to a
   * fresh controller here. Supplying it is the only way a caller-built transport gets the shutdown abort.
   */
  shutdownController?: AbortController;
  clock?: Clock;
  buckets?: Record<string, BucketConfig>;
  /** Safety factor applied to every documented rpm (default 0.7). */
  safety?: number;
  keys?: Partial<Record<SourceId, boolean>>;
  disabled?: SourceId[];
  /**
   * Solana RPC URL (default: public mainnet). Read-only methods only. A `mainnet.helius-rpc.com` URL
   * (see resolveRpcUrl) is treated as the keyed `helius` source: its own bucket, health entry and credit
   * meter, with the public RPC as the fallback for mint info and holders. Never log this value.
   */
  rpcUrl?: string;
  /**
   * Solana Tracker API key (see resolveTrackerKey). Sent only as the `x-api-key` header; never logged or recorded.
   * Absent = the keyed risk source stays 'needs-key' and every field it would fill stays null.
   */
  trackerKey?: string | null;
  /**
   * Shrine API key (see resolveShrineKey). Sent only in the socket.io CONNECT auth payload to the pinned
   * host; never logged or recorded. Absent = candles stay on GeckoTerminal and 'shrine' stays 'needs-key'.
   */
  shrineKey?: string | null;
  /** Test seam: socket options for the Shrine client (a fake WebSocket factory, fake timers). */
  shrineSocket?: Omit<ShrineSocketOptions, 'apiKey' | 'onHealth' | 'shutdownSignal'>;
  /** Fallback RPC when the primary fails (default: public mainnet when the primary is not already it; null disables). */
  rpcFallbackUrl?: string | null;
  /** Extra user-supplied free RPC endpoints (read-only) added to the pool after the primary. Never logged. */
  rpcExtraUrls?: string[];
  /** Add the keyless public RPC seed list (PUBLIC_RPC_POOL) to the pool for extra keyless reliability. Default false. */
  rpcPublicPool?: boolean;
  /** Helius credit meter settings (day budget, per-run cap). */
  credits?: Omit<CreditMeterOptions, 'clock' | 'cache' | 'onLevel'>;
  /** Per-source request budget meter settings (soft daily caps). */
  budget?: Omit<BudgetMeterOptions, 'clock' | 'cache'>;
  onRequest?: (req: HttpRequest, meta: RequestMeta, outcome: { status: number | null; latencyMs: number }) => void;
  /** Base pause after a 429 without Retry-After (doubles per consecutive 429 on a bucket; default 30 s). The signer process uses a shorter one (task-1368). */
  rateLimitPauseMs?: number;
}

export interface DataLayer {
  clock: Clock;
  cache: Cache;
  limiter: RateLimiter;
  health: HealthRegistry;
  http: HttpClient;
  dexscreener: DexScreener;
  jupiter: Jupiter;
  /** Keyless swap-quote source (SPEC §3.1 S11) — paper trading only; never builds/signs/sends. */
  jupiterSwap: JupiterSwap;
  gecko: GeckoTerminal;
  rpc: SolanaRpc;
  /** Public RPC behind a Helius/custom primary; null when the primary is the public one. */
  rpcFallback: SolanaRpc | null;
  /** RPC pool (rotation + health + 429 backoff) the detail layer reads through (task-1309). */
  rpcPool: RpcPool;
  rugcheck: RugCheck;
  goplus: GoPlus;
  /** Keyed risk source; null without a key. */
  tracker: SolanaTracker | null;
  /** Keyed 1 s candle source (socket.io); null without a key. close() closes its socket. */
  shrine: Shrine | null;
  /** Helius credit meter; null without a Helius endpoint. */
  credits: CreditMeter | null;
  /** Per-source request budget meter (visible usage, soft caps). */
  budget: BudgetMeter;
  candles: CandleStore;
  detail: TokenDetail;
  store: Store;
  close(): void;
}

/** `helius` for a Helius endpoint (keyed source S9), else the public/custom RPC source S6. */
export function rpcSourceFor(url: string | undefined): 'helius' | 'solana-rpc' {
  if (!url) return 'solana-rpc';
  try { return new URL(url).hostname === HELIUS_RPC_HOST ? 'helius' : 'solana-rpc'; } catch { return 'solana-rpc'; }
}

export function createDataLayer(opts: DataLayerOptions = {}): DataLayer {
  const clock = opts.clock ?? systemClock;
  const limiter = new RateLimiter(opts.buckets ?? DEFAULT_BUCKETS, clock, opts.safety);
  const rpcSource = rpcSourceFor(opts.rpcUrl);
  const keys = { ...opts.keys };
  if (rpcSource === 'helius') keys.helius = true;
  if (opts.trackerKey) keys.solanatracker = true;
  if (opts.shrineKey) keys.shrine = true;
  const health = new HealthRegistry({
    clock,
    keys,
    disabled: opts.disabled,
    usage: (source) => {
      const bucket = SOURCE_BUCKET[source];
      if (!bucket) return undefined;
      const s = limiter.bucket(bucket).stats();
      return { rpmUsed: s.rpmUsed, rpmLimit: s.rpmLimit };
    },
  });
  const cache = new Cache({ path: opts.dbPath, clock });
  // Helius credit meter: every request to the keyed endpoint is charged; at 90 % of the day budget or the
  // per-run cap the source is switched off (health `disabled`) so holders fall back to the public RPC.
  const credits = rpcSource === 'helius'
    ? new CreditMeter({
      ...opts.credits,
      clock,
      cache,
      onLevel: (level) => health.setDisabled('helius', level === 'degraded'),
    })
    : null;
  if (credits && credits.level() === 'degraded') health.setDisabled('helius', true);
  // Per-source request budget meter: counts every request (persisted per UTC day) so usage is visible.
  const budget = new BudgetMeter({ ...opts.budget, clock, cache });
  const onRequest: DataLayerOptions['onRequest'] = (req, meta, o) => {
    budget.charge(meta.source);
    if (credits && meta.source === 'helius') {
      let method: string | null = null;
      try { method = req.body ? ((JSON.parse(req.body) as { method?: string }).method ?? null) : null; } catch { method = null; }
      credits.charge(CreditMeter.costOf(method));
    }
    opts.onRequest?.(req, meta, o);
  };
  // Shutdown signal (task-1319): close() aborts it so any in-flight live fetch rejects immediately and
  // the event loop is not held for the per-request timeout. A caller that builds its own transport must
  // pass its controller as opts.shutdownController and build that transport with its signal, so close()
  // reaches the real app's transport (createLiveFeed does exactly this); otherwise we own the controller
  // and wire it into the default live transport.
  const shutdown = opts.shutdownController ?? new AbortController();
  const http = new HttpClient({ transport: opts.transport ?? liveTransport({ shutdownSignal: shutdown.signal }), limiter, health, clock, onRequest, ...(opts.rateLimitPauseMs !== undefined ? { rateLimitPauseMs: opts.rateLimitPauseMs } : {}) });
  const dexscreener = new DexScreener(http);
  const jupiter = new Jupiter(http);
  const jupiterSwap = new JupiterSwap(http);
  const gecko = new GeckoTerminal(http);
  const rpc = new SolanaRpc(http, { url: opts.rpcUrl, source: rpcSource });
  const fallbackUrl = opts.rpcFallbackUrl === undefined ? (rpc.url === SOLANA_PUBLIC_RPC ? null : SOLANA_PUBLIC_RPC) : opts.rpcFallbackUrl;
  const rpcFallback = fallbackUrl && fallbackUrl !== rpc.url ? new SolanaRpc(http, { url: fallbackUrl, source: 'solana-rpc' }) : null;
  // The pool the detail layer reads through. By default it mirrors the old primary+fallback pair exactly
  // (so behaviour is unchanged); extra user endpoints and the keyless public seed list are opt-in.
  const pool = new RpcPool(http, limiter, buildEndpointSpecs({ rpcUrl: rpc.url, rpcSource, fallbackUrl, opts }), { clock });
  // Keyless holder aggregate: Jupiter's holder count + top-10 share, used when no RPC endpoint serves the ranked list.
  const holdersAggregate = async (mint: string): Promise<HoldersAggregate | null> => {
    const views = await jupiter.search(mint);
    const v = views.find((x) => x.token.mint === mint) ?? views[0];
    if (!v) return null;
    return { holderCount: v.stats.holderCount, top10Pct: v.audit.top10Pct, source: 'jupiter-tokens', fetchedAt: v.stats.fetchedAt };
  };
  const rugcheck = new RugCheck(http);
  const goplus = new GoPlus(http);
  const tracker = opts.trackerKey ? new SolanaTracker(http, opts.trackerKey) : null;
  const candles = new CandleStore({ cache, gecko, clock });
  // Shrine (keyed): its socket closes on the same shutdown signal as the HTTP transport, so a quit never
  // waits on it. SOL/USD for its SOL-quoted rows comes from the keyless Jupiter price (cached 30 s).
  const shrine = opts.shrineKey
    ? new Shrine({
      apiKey: opts.shrineKey,
      accounts: (addresses) => pool.accountsInfo(addresses, 'confirmed'),
      solUsd: async () => (await cache.fetch('shrine:sol-usd', WSOL_MINT, async () => (await jupiter.price([WSOL_MINT])).get(WSOL_MINT)?.usdPrice ?? null, { ttlMs: TTL.price, source: 'jupiter-price', swr: false })).value,
      clock,
      limiter,
      health,
      onRequest: () => budget.charge('shrine'),
      socket: { ...opts.shrineSocket, shutdownSignal: shutdown.signal },
    })
    : null;
  const detail = new TokenDetail({ cache, gecko, pool, holdersAggregate, rugcheck, goplus, tracker, candles, shrine, health, clock });
  const store = new Store({ cache, dexscreener, jupiter });
  return { clock, cache, limiter, health, http, dexscreener, jupiter, jupiterSwap, gecko, rpc, rpcFallback, rpcPool: pool, rugcheck, goplus, tracker, shrine, credits, budget, candles, detail, store, close: () => { shutdown.abort(); shrine?.close(); limiter.close(); cache.close(); } };
}

/** Pool endpoints: the primary first (keyed when Helius/custom), then the public fallback, then any opt-in extras. */
function buildEndpointSpecs(args: { rpcUrl: string; rpcSource: 'helius' | 'solana-rpc'; fallbackUrl: string | null; opts: DataLayerOptions }): RpcEndpointSpec[] {
  const { rpcUrl, rpcSource, fallbackUrl, opts } = args;
  const specs: RpcEndpointSpec[] = [];
  const seen = new Set<string>();
  const add = (spec: RpcEndpointSpec) => {
    if (seen.has(spec.url)) return;
    seen.add(spec.url);
    specs.push(spec);
  };
  // Primary keeps its natural source bucket (helius 600rpm / solana-rpc 30rpm) and credit-meter semantics.
  const keyed = rpcSource === 'helius';
  add({ url: rpcUrl, source: rpcSource, bucket: rpcSource, rpm: keyed ? 600 : 30, burst: keyed ? 5 : 1, label: keyed ? 'Helius (free key)' : 'public RPC', keyed });
  if (fallbackUrl && fallbackUrl !== rpcUrl) add({ url: fallbackUrl, source: 'solana-rpc', bucket: 'solana-rpc', rpm: 30, burst: 1, label: 'public RPC (fallback)' });
  for (const url of opts.rpcExtraUrls ?? []) {
    const src = rpcSourceFor(url);
    add({ url, source: src, bucket: bucketFor(url), rpm: src === 'helius' ? 600 : 30, burst: src === 'helius' ? 5 : 1, label: 'user RPC', basis: 'env DEXTERM_RPC_URLS', keyed: src === 'helius' });
  }
  if (opts.rpcPublicPool) {
    for (const p of PUBLIC_RPC_POOL) add({ url: p.url, source: 'solana-rpc', bucket: bucketFor(p.url), rpm: 30, burst: 1, label: p.label, basis: p.basis });
  }
  return specs;
}
