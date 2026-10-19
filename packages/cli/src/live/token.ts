// trenchscope — live token detail binding (task-1298). Loads everything the TOKEN screen shows from the
// data layer, each panel independently, so one source being down leaves a caption, never a fake number:
//   price / deltas / mcap / liq / vol / holders count / organic  ← Store.enrich (DexScreener + Jupiter)
//   candles                                                      ← Shrine 1 s rows by mint (key), else GeckoTerminal
//   trades tape                                                  ← GeckoTerminal (pool from DexScreener's pair, else Gecko)
//   mint / freeze authority, top-20 holders, top-10 share        ← Helius (key) with the public RPC as fallback
//   RugCheck score + risks, LP locked                            ← RugCheck
//   second opinion (authorities, hooks, LP holders)              ← GoPlus
// Snipers / bundled / dev history stay null: they need the Helius history lane (SPEC §3.8 W1).
import type { Candle, CandleInterval, DataLayer, GoPlusSecurity, GtTrade, Launchpad, RpcHolder, TopHolders, TrackerRisk } from '@dexterm/data';
import { SourceUnavailableError, RateDeferredError, extractLinks, bestPairByMint, aggregateCandles, withPriority, CANDLE_BASE, CANDLE_BASE_INTERVALS, CANDLE_TIMEFRAMES, type CoinLink } from '@dexterm/data';
import { cleanText, deriveFlags, impliedSpark, type RiskFlag, type ScreenerRow } from '../screener/rows.ts';

export type Panel = 'market' | 'candles' | 'authorities' | 'holders' | 'rugcheck' | 'goplus' | 'trades';
export const PANELS: Panel[] = ['market', 'candles', 'authorities', 'holders', 'rugcheck', 'goplus', 'trades'];
export const INTERVALS: CandleInterval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
/** task-1314: one big fetch per base interval (1m, 1h) covers every tab via local aggregation. */
export const DEFAULT_CANDLE_BASE_LIMIT = 1000;
/** How long the candle/trades loader waits for DexScreener's pair before asking GeckoTerminal for the pool (task-1323). */
export const POOL_WAIT_MS = 1_500;
/** Refresh cadence for the open token (SPEC §3.4 says 3 s for the selected token; the cache TTLs do the real pacing). */
export const TOKEN_REFRESH_MS = 10_000;

export interface LiveHolder {
  address: string;
  pct: number;
  amount: number;
  label: string | null;
  /** True when `address` is the token account itself (owner lookup failed). */
  tokenAccountOnly: boolean;
}

export interface LiveTrade {
  t: number;
  side: 'buy' | 'sell';
  usd: number;
  price: number;
  wallet: string;
}

export interface PanelStatus {
  state: 'idle' | 'loading' | 'ok' | 'error' | 'needs-key';
  /** Which source answered (`helius`, `solana-rpc`, `geckoterminal`, ...). */
  via: string | null;
  /** Short, printable reason when state is error/needs-key. Never contains a URL secret (HttpError redacts). */
  reason: string | null;
  fetchedAt: number | null;
  stale: boolean;
}

/** Everything the live TOKEN screen renders. Nulls mean "no source said"; the panel status says why. */
export interface TokenView {
  mint: string;
  symbol: string;
  name: string;
  launchpad: Launchpad;
  pair: string | null;
  price: number | null;
  chg: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  mcap: number | null;
  mcapFlagged: boolean;
  fdv: number | null;
  liq: number | null;
  vol24: number | null;
  holders: number | null;
  holdersChgPct: number | null;
  org: number | null;
  ageMin: number | null;
  socials: { x: boolean; tg: boolean; web: boolean };
  /**
   * Real link URLs the coin advertises (task-1315), merged across Jupiter + DexScreener in the store.
   * `socials` keeps the booleans the header badges use; these carry the hrefs the `W`/`X`/`T` keys open.
   * null means no source supplied that link.
   */
  socialLinks: { web: string | null; x: string | null; tg: string | null; all?: CoinLink[] };
  verified: boolean;
  sus: boolean;
  /** Coin image URL (task-1326), null when no source advertises one. */
  image: string | null;
  spark: number[] | undefined;
  interval: CandleInterval;
  candles: Candle[];
  holdersTop: LiveHolder[];
  /** `top 20 · 55.0% of supply` style sample note (SPEC §3.8: every people-metric prints its sample). */
  holdersSample: string | null;
  /** Top-10 share by token account, LP-labelled accounts excluded (SPEC §3.6). */
  top10: number | null;
  dev: number | null;
  devMints: number | null;
  /** 0.1.5 dev history: the creator wallet Jupiter names (keyless `dev`); null = not reported. */
  devAddress?: string | null;
  lpLocked: number | null;
  mintAuth: boolean | null;
  freezeAuth: boolean | null;
  tokenProgram: string | null;
  riskyExtensions: string[];
  rug: { score: number | null; raw: number | null; risks: { name: string; level: string }[]; lpLockedPct: number | null } | null;
  goplus: GoPlusSecurity | null;
  trades: LiveTrade[];
  snipers: null;
  bundled: null;
  /** DexScreener dex id of the pair (`pumpfun` = still on the bonding curve). */
  dex: string | null;
  /** Solana Tracker risk read (keyed). `trackerState` off = no key configured. */
  tracker: TrackerRisk | null;
  trackerState: 'off' | 'loading' | 'ok' | 'error';
  flags: RiskFlag[];
  panels: Record<Panel, PanelStatus>;
  /** Local ms of the last completed load. */
  updatedAt: number | null;
  sources: string[];
}

const idle = (): PanelStatus => ({ state: 'idle', via: null, reason: null, fetchedAt: null, stale: false });

/** What it takes to open a token: identity plus whatever market fields the caller's row already has. */
export type TokenSeed = Pick<ScreenerRow, 'mint' | 'symbol' | 'name' | 'launchpad'>
  & Partial<Pick<ScreenerRow, 'pair' | 'price' | 'mcap' | 'mcapFlagged' | 'fdv' | 'liq' | 'vol24' | 'holders' | 'holdersChgPct' | 'org' | 'ageMin' | 'verified' | 'sus' | 'spark' | 'top10' | 'dev' | 'lpLocked' | 'mintAuth' | 'freezeAuth' | 'flags' | 'image' | 'dex'>>
  & { chg?: Partial<ScreenerRow['chg']> };

export function emptyView(row: TokenSeed, interval: CandleInterval = '1h'): TokenView {
  const panels = Object.fromEntries(PANELS.map((p) => [p, idle()])) as Record<Panel, PanelStatus>;
  return {
    mint: row.mint, symbol: row.symbol, name: row.name, launchpad: row.launchpad, pair: row.pair ?? null,
    price: row.price ?? null, chg: { m5: row.chg?.m5 ?? null, h1: row.chg?.h1 ?? null, h6: row.chg?.h6 ?? null, h24: row.chg?.h24 ?? null },
    mcap: row.mcap ?? null, mcapFlagged: row.mcapFlagged ?? false, fdv: row.fdv ?? null, liq: row.liq ?? null, vol24: row.vol24 ?? null,
    holders: row.holders ?? null, holdersChgPct: row.holdersChgPct ?? null, org: row.org ?? null, ageMin: row.ageMin ?? null,
    socials: { x: false, tg: false, web: false }, socialLinks: { web: null, x: null, tg: null }, verified: row.verified ?? false, sus: row.sus ?? false, image: row.image ?? null, spark: row.spark,
    interval, candles: [], holdersTop: [], holdersSample: null, top10: row.top10 ?? null, dev: row.dev ?? null, devMints: null,
    lpLocked: row.lpLocked ?? null, mintAuth: row.mintAuth ?? null, freezeAuth: row.freezeAuth ?? null, tokenProgram: null, riskyExtensions: [],
    rug: null, goplus: null, trades: [], snipers: null, bundled: null, dex: row.dex ?? null, tracker: null, trackerState: 'off', flags: row.flags ?? [], panels, updatedAt: null, sources: [],
  };
}

function reasonOf(err: unknown): { state: PanelStatus['state']; reason: string } {
  if (err instanceof SourceUnavailableError) {
    const m = /is (needs-key|disabled|degraded|probing)/.exec(err.message);
    const st = m?.[1];
    return { state: st === 'needs-key' ? 'needs-key' : 'error', reason: st === 'needs-key' ? 'needs key' : st === 'disabled' ? `${err.source} off` : `${err.source} degraded` };
  }
  const msg = err instanceof Error ? err.message : String(err);
  const http = /HTTP (\d{3})/.exec(msg);
  if (http) return { state: 'error', reason: http[1] === '429' ? 'rate limited (429)' : `HTTP ${http[1]}` };
  if (/no recorded fixture/.test(msg)) return { state: 'error', reason: 'not in recording' };
  if (/budget exhausted/.test(msg)) return { state: 'error', reason: 'request budget exhausted' };
  // never echo URLs (they can carry keys and are too long for a caption): keep the host at most
  const clean = msg.replace(/https?:\/\/([^/\s?]+)[^\s]*/g, '$1').replace(/\s+/g, ' ').trim();
  return { state: 'error', reason: clean.slice(0, 60) };
}

function holdersFrom(h: TopHolders): { top: LiveHolder[]; sample: string } {
  // task-1309: keyless aggregate — no ranked list, just count + top-10 share from Jupiter.
  if (h.aggregateOnly) {
    const count = typeof h.holderCount === 'number' ? h.holderCount.toLocaleString('en-US') : '?';
    const top10 = h.top10Pct !== null ? `top-10 ${h.top10Pct.toFixed(1)}%` : 'top-10 n/a';
    return { top: [], sample: `${count} holders · ${top10} · list needs a free RPC key` };
  }
  const top = h.holders.map((x: RpcHolder): LiveHolder => ({ address: x.address, pct: x.pct, amount: x.amount, label: x.label ?? null, tokenAccountOnly: x.owner === null }));
  const share = top.reduce((s, x) => s + x.pct, 0);
  return { top, sample: `top ${top.length} · ${share.toFixed(1)}% of supply` };
}

export interface TokenLiveOptions {
  interval?: CandleInterval;
  now?: () => number;
  /** Called after every panel settles (the interactive loop redraws). */
  onChange?: (view: TokenView) => void;
  candleLimit?: number;
  /** Bars fetched per base interval (1m, 1h); coarser tabs derive from these (task-1314). Default 1000. */
  candleBaseLimit?: number;
  /** Warm both base intervals in the background after the first load so every tab paints instantly.
   *  Default true; the exact-call-count fixture test turns it off. */
  prefetchCandles?: boolean;
}

/** A base or derived series kept in memory; `via` is the source that served its base (shrine / geckoterminal). */
export interface CachedBars { candles: Candle[]; fetchedAt: number; stale: boolean; derived: boolean; via: string }

/** One open token. `load()` refreshes every panel through the cache (cheap when within TTL). */
export class TokenLive {
  readonly dl: DataLayer;
  view: TokenView;
  private readonly now: () => number;
  private readonly onChange?: (view: TokenView) => void;
  private readonly candleLimit: number;
  private readonly candleBaseLimit: number;
  private readonly prefetchCandles: boolean;
  private loading: Promise<void> | null = null;
  private generation = 0;
  /** Per-interval candles kept in memory: native base fetches (1m, 1h) plus their local derivations,
   *  so a timeframe switch paints instantly from memory while a background refresh reconciles (task-1314). */
  private readonly bars = new Map<CandleInterval, CachedBars>();
  private prefetching: Promise<void> | null = null;
  /** The current load's market (DexScreener) leg, so the pool lookup can wait for its pair (task-1323). */
  private marketLoad: Promise<void> | null = null;

  constructor(dl: DataLayer, row: TokenSeed, opts: TokenLiveOptions = {}) {
    this.dl = dl;
    this.view = emptyView(row, opts.interval ?? '1h');
    this.now = opts.now ?? (() => Date.now());
    this.onChange = opts.onChange;
    this.candleLimit = opts.candleLimit ?? 120;
    this.candleBaseLimit = opts.candleBaseLimit ?? DEFAULT_CANDLE_BASE_LIMIT;
    this.prefetchCandles = opts.prefetchCandles ?? true;
  }

  get mint(): string {
    return this.view.mint;
  }

  setInterval(iv: CandleInterval): Promise<void> {
    if (this.view.interval === iv) return Promise.resolve();
    this.view.interval = iv;
    // Progressive paint: show the cached or locally-derived series instantly, never a blank chart,
    // while the background refresh reconciles. Only a truly cold tab (no base cached yet) shows the
    // loading marker (task-1314).
    if (!this.applyInterval(iv)) { this.view.candles = []; this.view.panels.candles = { ...idle(), state: 'loading' }; }
    this.emit();
    return this.loadCandles(++this.generation);
  }

  /** Paint `view.candles` for `iv` from the in-memory base/derived cache. Returns false when nothing is
   *  cached yet (cold: the caller shows the loading marker and a fetch fills it in). */
  private applyInterval(iv: CandleInterval): boolean {
    const got = this.candlesFor(iv);
    if (!got || got.candles.length === 0) return false;
    this.view.candles = got.candles.slice(-this.candleLimit);
    this.view.panels.candles = { state: 'ok', via: got.via, reason: null, fetchedAt: got.fetchedAt, stale: got.stale };
    return true;
  }

  /** Cached series for `iv`: a direct base hit, else derived on demand from its base interval. */
  private candlesFor(iv: CandleInterval): CachedBars | null {
    const direct = this.bars.get(iv);
    if (direct) return direct;
    const base = CANDLE_BASE[iv];
    if (!base) return null;
    const src = this.bars.get(base);
    if (!src || src.candles.length === 0) return null;
    const candles = aggregateCandles(src.candles, CANDLE_TIMEFRAMES[base].periodMs, CANDLE_TIMEFRAMES[iv].periodMs);
    if (candles.length === 0) return null;
    const entry = { candles, fetchedAt: src.fetchedAt, stale: src.stale, derived: true, via: src.via };
    this.bars.set(iv, entry);
    return entry;
  }

  /**
   * task-1325: the full cached series for `iv` for the chart popup — a base hit or a local derivation
   * (5m/15m from 1m, 4h/1d from 1h), NEVER a fetch. null while that base is not in memory yet (the popup
   * shows "warming" and picks it up on the next tick, once the terminal's own load/prefetch fills it).
   */
  cachedSeries(iv: CandleInterval): CachedBars | null {
    const got = this.candlesFor(iv);
    return got && got.candles.length > 0 ? got : null;
  }

  /** Store a freshly fetched base series and recompute every tab that derives from it. */
  private setBase(base: CandleInterval, candles: Candle[], fetchedAt: number, stale: boolean, via = 'geckoterminal'): void {
    this.bars.set(base, { candles, fetchedAt, stale, derived: false, via });
    for (const iv of INTERVALS) {
      if (CANDLE_BASE[iv] === base) this.bars.delete(iv); // drop the stale derivation; recomputed lazily
    }
  }

  /**
   * Warm both base intervals (1m, 1h) in the background so every timeframe tab paints instantly from
   * local aggregation. Cheap within the GeckoTerminal view TTL (the store serves the cached series);
   * coalesced so concurrent callers share one pass. task-1323: LOW priority (never takes the bucket's
   * foreground reserve, so a cold tab the user presses meanwhile goes out first), and a base already in
   * memory is not re-fetched — the viewed base is kept fresh by load(), the other one by its own switch.
   */
  prefetchAdjacent(): Promise<void> {
    if (this.prefetching) return this.prefetching;
    this.prefetching = (async () => {
      const pool = this.view.pair ?? (await this.pool().catch(() => null)) ?? '';
      if (!pool && !this.dl.detail.hasShrine) return;
      for (const base of CANDLE_BASE_INTERVALS) {
        const have = this.bars.get(base);
        if (have && !have.derived && have.candles.length > 0) continue;
        try {
          const s = await withPriority('low', () => this.dl.detail.candles(pool, base, { limit: this.candleBaseLimit, token: this.view.mint }));
          this.setBase(base, s.candles, s.fetchedAt, s.stale, s.source);
          if (this.view.interval === base || CANDLE_BASE[this.view.interval] === base) { this.applyInterval(this.view.interval); this.emit(); }
        } catch { /* leave it; the viewed tab still has its own fetch */ }
      }
    })().finally(() => { this.prefetching = null; });
    return this.prefetching;
  }

  private emit(): void {
    this.onChange?.(this.view);
  }

  private start(p: Panel): void {
    const cur = this.view.panels[p];
    this.view.panels[p] = { ...cur, state: cur.state === 'ok' ? 'ok' : 'loading' };
  }

  private ok(p: Panel, via: string | null, fetchedAt: number | null, stale = false): void {
    this.view.panels[p] = { state: 'ok', via, reason: null, fetchedAt, stale };
  }

  private fail(p: Panel, err: unknown): void {
    const r = reasonOf(err);
    const cur = this.view.panels[p];
    // keep stale data on screen (SWR) but say the refresh failed
    this.view.panels[p] = { state: r.state, via: cur.via, reason: r.reason, fetchedAt: cur.fetchedAt, stale: cur.fetchedAt !== null };
  }

  /** Load / refresh every panel in parallel. Never throws. Coalesces concurrent calls. */
  load(): Promise<void> {
    if (this.loading) return this.loading;
    const gen = ++this.generation;
    for (const p of PANELS) this.start(p);
    this.emit();
    const market = this.loadMarket(gen);
    this.marketLoad = market;
    this.loading = Promise.all([
      market,
      this.loadChainAndSecurity(gen),
      this.loadPoolCandlesTrades(gen),
    ]).then(() => {
      if (gen === this.generation) { this.view.updatedAt = this.now(); this.emit(); }
      // Warm the other base interval so every timeframe tab is instant (task-1314). Background, budgeted.
      if (this.prefetchCandles) void this.prefetchAdjacent();
    }).finally(() => { this.loading = null; });
    return this.loading;
  }

  private async loadMarket(gen: number): Promise<void> {
    const v = this.view;
    try {
      const res = await this.dl.store.enrich([v.mint], { price: true });
      if (gen !== this.generation) return;
      const r = res.rows[0];
      if (!r) throw new Error(Object.values(res.errors)[0] ?? 'no market data for this mint');
      const { token, pair, stats, audit } = r;
      v.symbol = cleanText(token.symbol, 12) || v.symbol;
      v.name = cleanText(token.name, 40) || v.name;
      if (token.launchpad !== 'unknown') v.launchpad = token.launchpad;
      v.pair = v.pair ?? (pair.pairAddress || null);
      v.dex = pair.dex || v.dex;
      v.price = pair.priceUsd > 0 ? pair.priceUsd : r.price?.usdPrice ?? v.price;
      v.chg = { m5: pair.priceChange.m5, h1: pair.priceChange.h1, h6: pair.priceChange.h6, h24: pair.priceChange.h24 };
      // task-1311 (QA M9): a fresh pump.fun pair has no indexed pool yet, so these come back null.
      // Keep what the new-pairs stream already seeded (mcap/price/age) instead of blanking the screen.
      v.mcap = r.mcap && r.mcap.value != null ? r.mcap.value : (pair.mcap ?? pair.fdv ?? v.mcap);
      v.mcapFlagged = r.mcap?.flagged ?? false;
      v.fdv = pair.fdv ?? v.fdv;
      v.liq = pair.liquidityUsd ?? v.liq;
      v.vol24 = pair.volume.h24 ?? v.vol24;
      v.holders = stats?.holderCount ?? v.holders;
      v.holdersChgPct = stats?.holders24hDelta ?? null;
      v.org = stats?.organicScore ?? null;
      const created = token.createdAt ?? pair.createdAt;
      v.ageMin = created ? Math.max(0, (this.now() - created) / 60000) : v.ageMin;
      v.socials = { x: !!token.socials.x, tg: !!token.socials.tg, web: !!token.socials.web };
      // task-1315: keep the real hrefs so the token screen's W/X/T keys can open them (after scheme check).
      v.socialLinks = { web: token.socials.web ?? null, x: token.socials.x ?? null, tg: token.socials.tg ?? null };
      try {
        const raw = await this.dl.dexscreener.tokensRaw([v.mint]);
        if (gen !== this.generation) return;
        const pair = bestPairByMint(raw.pairs, [v.mint]).get(v.mint);
        const links = extractLinks({ dexscreener: pair, jupiter: { website: token.socials.web, twitter: token.socials.x, telegram: token.socials.tg } });
        v.socialLinks = { web: links.website, x: links.x, tg: links.telegram, all: links.all };
      } catch { /* retain the enriched primary links when the full list is unavailable */ }
      v.verified = token.verified;
      v.sus = token.sus;
      if (typeof token.image === 'string' && /^https?:\/\//i.test(token.image)) v.image = token.image;
      v.spark = r.sparkline ?? impliedSpark(v.price, v.chg);
      // Jupiter's audit fills what chain truth has not (yet): the chain panel overwrites these when it lands.
      if (v.panels.authorities.state !== 'ok') {
        v.mintAuth = audit?.mintAuthority ?? v.mintAuth;
        v.freezeAuth = audit?.freezeAuthority ?? v.freezeAuth;
      }
      if (v.panels.holders.state !== 'ok') v.top10 = audit?.top10Pct ?? v.top10;
      v.dev = audit?.devPct ?? null;
      v.devMints = audit?.devMints ?? null;
      v.devAddress = audit?.devAddress ?? v.devAddress ?? null;
      v.sources = [...new Set([...v.sources, ...r.sources])];
      const SHORT: Record<string, string> = { dexscreener: 'ds', 'jupiter-tokens': 'jup', 'jupiter-price': 'jup-price' };
      this.ok('market', r.sources.map((x) => SHORT[x] ?? x).join('+'), pair.fetchedAt, r.stale);
    } catch (err) {
      if (gen !== this.generation) return;
      this.fail('market', err);
    }
    this.recomputeFlags();
    this.emit();
  }

  private async loadChainAndSecurity(gen: number): Promise<void> {
    const v = this.view;
    await Promise.all([
      (async () => {
        try {
          const info = await this.dl.detail.mintInfo(v.mint);
          if (gen !== this.generation) return;
          v.mintAuth = info.value.mintAuthority !== null;
          v.freezeAuth = info.value.freezeAuthority !== null;
          v.tokenProgram = info.value.program;
          v.riskyExtensions = info.value.riskyExtensions;
          this.ok('authorities', info.value.source, info.fetchedAt, info.stale);
        } catch (err) {
          if (gen === this.generation) this.fail('authorities', err);
        }
        this.recomputeFlags();
        this.emit();
      })(),
      (async () => {
        try {
          const h = await this.dl.detail.holders(v.mint);
          if (gen !== this.generation) return;
          const { top, sample } = holdersFrom(h.value);
          v.holdersTop = top;
          v.holdersSample = sample;
          v.top10 = h.value.top10Pct;
          this.ok('holders', h.value.source, h.fetchedAt, h.stale);
        } catch (err) {
          if (gen === this.generation) this.fail('holders', err);
        }
        this.recomputeFlags();
        this.emit();
      })(),
      (async () => {
        try {
          const r = await this.dl.detail.rugcheck(v.mint);
          if (gen !== this.generation) return;
          v.rug = { score: r.value.scoreNormalised, raw: r.value.score, risks: r.value.risks.map((x) => ({ name: x.name, level: x.level })), lpLockedPct: r.value.lpLockedPct };
          v.lpLocked = r.value.lpLockedPct ?? v.lpLocked; // never invent a figure: the row's PumpSwap rule already applied
          this.ok('rugcheck', 'rugcheck', r.fetchedAt, r.stale);
        } catch (err) {
          if (gen === this.generation) this.fail('rugcheck', err);
        }
        this.recomputeFlags();
        this.emit();
      })(),
      (async () => {
        // Solana Tracker (keyed): fills only what the keyless sources left unknown, and adds snipers,
        // insiders, bundlers and a rugged verdict. A failure (no credits, 403) says so; it never blanks a value.
        if (!this.dl.detail.hasTracker) return;
        v.trackerState = 'loading';
        try {
          const r = await this.dl.detail.trackerRisk(v.mint);
          if (gen !== this.generation) return;
          const t = r.value;
          v.tracker = t;
          v.trackerState = 'ok';
          v.dev = v.dev ?? t.devPct;
          v.top10 = v.top10 ?? t.top10Pct;
          v.mintAuth = v.mintAuth ?? t.mintAuthority;
          v.freezeAuth = v.freezeAuth ?? t.freezeAuthority;
          if (v.lpLocked === null && t.onCurve !== true && t.lpBurnPct !== null) v.lpLocked = t.lpBurnPct;
        } catch {
          if (gen === this.generation) v.trackerState = 'error';
        }
        this.recomputeFlags();
        this.emit();
      })(),
      (async () => {
        try {
          const g = await this.dl.detail.security(v.mint);
          if (gen !== this.generation) return;
          v.goplus = g.value;
          if (v.panels.authorities.state !== 'ok') {
            v.mintAuth = g.value.mintable ?? v.mintAuth;
            v.freezeAuth = g.value.freezable ?? v.freezeAuth;
          }
          if (v.holders === null && g.value.holderCount !== null) v.holders = g.value.holderCount;
          this.ok('goplus', 'goplus', g.fetchedAt, g.stale);
        } catch (err) {
          if (gen === this.generation) this.fail('goplus', err);
        }
        this.recomputeFlags();
        this.emit();
      })(),
    ]);
  }

  private async pool(): Promise<string | null> {
    if (this.view.pair) return this.view.pair;
    // task-1323: a token opened by mint alone (no screener row) learns its pair from the market leg
    // (DexScreener, fast bucket) moments later; wait briefly for it instead of spending a GeckoTerminal
    // call — the chart's own bucket — on a pool lookup.
    if (this.marketLoad) {
      let t: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([this.marketLoad, new Promise<void>((r) => { t = setTimeout(r, POOL_WAIT_MS); (t as { unref?: () => void }).unref?.(); })]);
      if (t) clearTimeout(t);
      if (this.view.pair) return this.view.pair;
    }
    const p = await withPriority('high', () => this.dl.detail.topPool(this.view.mint));
    if (p) this.view.pair = p.address;
    return p?.address ?? null;
  }

  private async loadPoolCandlesTrades(gen: number): Promise<void> {
    let pool: string | null = null;
    try {
      pool = await this.pool();
    } catch (err) {
      if (gen !== this.generation) return;
      this.fail('trades', err);
      if (this.dl.detail.hasShrine) { await this.loadCandles(gen); return; }
      this.fail('candles', err);
      this.emit();
      return;
    }
    if (!pool) {
      const e = new Error('no pool found for this mint');
      this.fail('trades', e);
      // Shrine charts by mint: a coin with no indexed pair yet can still have a chart.
      if (this.dl.detail.hasShrine) { await this.loadCandles(gen); return; }
      this.fail('candles', e);
      this.emit();
      return;
    }
    await Promise.all([this.loadCandles(gen), this.loadTrades(gen, pool)]);
  }

  private async loadCandles(gen: number): Promise<void> {
    const v = this.view;
    const iv = v.interval;
    // Fetch the base interval the viewed tab derives from (1m or 1h); coarser tabs never hit the network.
    const base = CANDLE_BASE[iv] ?? iv;
    // task-1323: an EMPTY chart is what the user is waiting on — HIGH priority, which may use the
    // GeckoTerminal bucket's reserved slot and jumps queued background work. A chart that already shows
    // candles (poll refresh, SWR) is LOW: it must never take that slot from the next cold tab.
    const priority = v.candles.length === 0 ? 'high' : 'low';
    try {
      // With a Shrine key the chart needs only the mint; the pool is GeckoTerminal's fallback.
      const pool = v.pair ?? (this.dl.detail.hasShrine ? (await this.pool().catch(() => null)) ?? '' : await this.pool());
      if (!pool && !this.dl.detail.hasShrine) throw new Error('no pool found for this mint');
      const s = await withPriority(priority, () => this.dl.detail.candles(pool ?? '', base, { limit: this.candleBaseLimit, token: v.mint }));
      this.setBase(base, s.candles, s.fetchedAt, s.stale, s.source);
      if (gen !== this.generation) return; // user switched tabs mid-fetch; the cache is still warmed
      this.applyInterval(iv);
      // A base refresh that returned nothing (dead pool) still leaves an empty chart: surface it.
      if (v.candles.length === 0) this.fail('candles', new Error('no candles returned'));
    } catch (err) {
      // Keep any derived/cached candles on screen (SWR); only report when the chart is actually empty.
      if (gen === this.generation && v.candles.length === 0) this.fail('candles', err);
    }
    this.emit();
  }

  private async loadTrades(gen: number, pool: string): Promise<void> {
    const v = this.view;
    try {
      // task-1323: the tape is background to the chart on the shared GeckoTerminal bucket (LOW).
      const r = await withPriority('low', () => this.dl.detail.trades(pool, v.mint));
      if (gen !== this.generation) return;
      v.trades = r.value.slice(0, 60).map((t: GtTrade): LiveTrade => ({ t: t.t, side: t.side, usd: t.usd, price: t.price, wallet: t.wallet }));
      this.ok('trades', 'geckoterminal', r.fetchedAt, r.stale);
    } catch (err) {
      if (gen === this.generation) this.fail('trades', err);
    }
    this.emit();
  }

  private recomputeFlags(): void {
    const v = this.view;
    if (v.dex === 'pumpfun') v.lpLocked = null; // on the bonding curve there is no LP, whatever a source reports
    v.flags = deriveFlags({ mintAuth: v.mintAuth, freezeAuth: v.freezeAuth, top10: v.top10, dev: v.dev, bundled: null, lpLocked: v.lpLocked, liq: v.liq, mcap: v.mcap, h24: v.chg.h24 });
  }
}

/** Debounce before the screener cursor's row counts as "hovered" (task-1323). */
export const HOVER_DEBOUNCE_MS = 350;
/**
 * Soft cap on hover-prefetch requests per rolling minute (task-1323). The GeckoTerminal bucket allows 7
 * per 60 s, but the keyless server was seen answering 429 at 6 in ~47 s; hover keeps to 3 so at least
 * 4 slots per minute stay for the token screen (open, cold tab, tape).
 */
export const HOVER_MAX_PER_MIN = 3;

export interface HoverTarget { mint: string; pair: string | null }

export interface CandlePrefetcherOptions {
  /** The timeframe the token screen will open on (its base is warmed first, then the other base). */
  interval: () => CandleInterval;
  debounceMs?: number;
  maxPerMin?: number;
  /** Bars per base: must match TokenLive's candleBaseLimit so the open finds a usable series. */
  limit?: number;
  now?: () => number;
}

/**
 * Hover prefetch for the screener (task-1323): when the cursor rests on a row for `debounceMs`, warm
 * that token's candle bases (the token screen's default base first, then the other one) so ⏎ paints a
 * chart instantly. Budget-safe by construction:
 *  - IDLE priority: a request is only issued when the GeckoTerminal bucket is completely idle with its
 *    foreground reserve intact — otherwise acquire() refuses at once (RateDeferredError) and nothing is
 *    sent or queued, so scrolling can never starve the token screen or build a backlog;
 *  - debounced: a fast scroll through the list only ever considers the row it stops on;
 *  - soft cap of `maxPerMin` issued requests per rolling minute;
 *  - bases already cached (fresh or stale) are skipped.
 */
export class CandlePrefetcher {
  private readonly dl: DataLayer;
  private readonly opts: Required<Omit<CandlePrefetcherOptions, 'interval'>> & Pick<CandlePrefetcherOptions, 'interval'>;
  private target: HoverTarget | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private closed = false;
  private settledPromise: Promise<void> = Promise.resolve();
  private resolveSettled: (() => void) | null = null;
  private waitingForSettled = false;
  private readonly stamps: number[] = [];
  /** Requests actually sent (granted by the limiter). */
  requests = 0;
  /** Attempts the limiter refused because the bucket was not idle (nothing sent). */
  deferred = 0;

  constructor(dl: DataLayer, opts: CandlePrefetcherOptions) {
    this.dl = dl;
    this.opts = {
      interval: opts.interval,
      debounceMs: opts.debounceMs ?? HOVER_DEBOUNCE_MS,
      maxPerMin: opts.maxPerMin ?? HOVER_MAX_PER_MIN,
      limit: opts.limit ?? DEFAULT_CANDLE_BASE_LIMIT,
      now: opts.now ?? (() => Date.now()),
    };
  }

  /** The row under the cursor changed (or null: left the screener). Restarts the debounce on a new mint. */
  hover(t: HoverTarget | null): void {
    if (this.closed) return;
    if (t && this.target && t.mint === this.target.mint && t.pair === this.target.pair) return; // same row: keep waiting
    this.finishSettled(); // a replaced target can no longer do useful work for its caller
    this.target = t;
    if (t?.pair) this.settledPromise = new Promise<void>((resolve) => { this.resolveSettled = resolve; });
    this.schedule(this.opts.debounceMs);
  }

  /**
   * Resolve after the current hover pass has warmed every immediately available base, explicitly
   * deferred the next attempt, failed a real request, been replaced, or been cancelled by close(). This
   * is the completion contract for callers that need to observe the pass result; a debounce timer firing
   * alone does not mean its sequential requests have finished.
   */
  settled(): Promise<void> {
    if (this.resolveSettled) {
      this.waitingForSettled = true;
      (this.timer as { ref?: () => void } | null)?.ref?.();
    }
    return this.settledPromise;
  }

  /** Requests sent in the trailing 60 s. */
  rate(): number {
    const now = this.opts.now();
    while (this.stamps.length && this.stamps[0] + 60_000 <= now) this.stamps.shift();
    return this.stamps.length;
  }

  close(): void {
    this.closed = true;
    this.target = null;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.finishSettled();
  }

  private schedule(ms: number): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const t = this.target;
    if (!t || !t.pair || this.closed) return;
    this.timer = setTimeout(() => { this.timer = null; void this.step(t); }, Math.max(0, ms));
    if (this.waitingForSettled) (this.timer as { ref?: () => void }).ref?.();
    else (this.timer as { unref?: () => void }).unref?.();
  }

  private bases(): CandleInterval[] {
    const iv = this.opts.interval();
    const first = CANDLE_BASE[iv] ?? iv;
    return [first, ...CANDLE_BASE_INTERVALS.filter((b) => b !== first)];
  }

  private async step(t: HoverTarget): Promise<void> {
    if (this.closed || this.target !== t || !t.pair) return;
    if (this.busy) { this.schedule(250); return; } // the previous row's request is still in flight
    for (const base of this.bases()) {
      const req = { limit: this.opts.limit, token: t.mint };
      if (this.dl.detail.candleStore.has(t.pair, base, req)) continue;
      if (this.rate() >= this.opts.maxPerMin) {
        this.schedule(this.stamps[0] + 60_000 - this.opts.now() + 50);
        this.finishSettled(t);
        return;
      }
      this.busy = true;
      try {
        await withPriority('idle', () => this.dl.detail.candles(t.pair as string, base, req));
        this.sent();
      } catch (err) {
        if (err instanceof RateDeferredError) {
          this.deferred++;
          // Try again when the bucket could be idle again (still only if the cursor stays here).
          const wait = this.dl.limiter.bucket('geckoterminal').delayFor('idle', this.opts.now());
          this.schedule(Number.isFinite(wait) ? Math.max(250, wait) : 60_000);
          this.finishSettled(t);
          return;
        }
        this.sent(); // a real request that failed (HTTP error) still counts against the budget
        this.finishSettled(t);
        return;
      } finally {
        this.busy = false;
      }
      if (this.closed || this.target !== t) return; // the cursor moved on: its own debounce takes over
    }
    this.finishSettled(t);
  }

  private finishSettled(t?: HoverTarget): void {
    if (t && this.target !== t) return;
    const resolve = this.resolveSettled;
    this.resolveSettled = null;
    if (this.waitingForSettled) (this.timer as { unref?: () => void } | null)?.unref?.();
    this.waitingForSettled = false;
    resolve?.();
  }

  private sent(): void {
    this.requests++;
    this.stamps.push(this.opts.now());
  }
}

/** Short printable caption for a panel: `via helius · 12s`, `unavailable: rate limited (429)`, `needs key`. */
export function panelCaption(p: PanelStatus, now: number, label = 'unavailable'): string {
  if (p.state === 'needs-key') return 'needs key';
  if (p.state === 'loading' && p.fetchedAt === null) return 'loading…';
  if ((p.state === 'error') && p.fetchedAt === null) return `${label}: ${p.reason ?? 'error'}`;
  const age = p.fetchedAt === null ? '' : ` · ${Math.max(0, Math.round((now - p.fetchedAt) / 1000))}s`;
  const stale = p.state === 'error' ? ` · stale (${p.reason ?? 'refresh failed'})` : p.stale ? ' · stale' : '';
  return `${p.via ? `via ${p.via}` : ''}${age}${stale}`.replace(/^ · /, '');
}
