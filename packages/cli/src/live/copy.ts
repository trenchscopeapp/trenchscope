// trenchscope — live binding for COPY TRADING Tier 1 (task-1360): the follow store + wallet tracker for this run.
// Live mode polls Helius history for every followed wallet (10 credits a call, through the data layer's limiter
// and credit meter) and queues alerts the loop turns into toasts; fixtures / replay / keyless get the same store
// with an honestly UNAVAILABLE tracker. Read-only: nothing here trades, signs or proposes.
import { HeliusHistory, systemClock, type Clock, type DataLayer } from '@dexterm/data';
import { FollowStore, WalletTracker, defaultFollowsPath, type CopyAlert, type CopyAuto, type FollowRecord, type HistorySource, type MirrorMarket, type TrackerStatus, type WalletStats, type WalletTrade } from '@dexterm/data/copy';

export interface CopyLiveOptions {
  onChange?: (reason: string) => void;
  /** null = in-memory store (tests); undefined = ~/.dexterm/follows.json */
  followsPath?: string | null;
  env?: NodeJS.ProcessEnv;
  solUsd?: () => number | null;
  /** Test seam: a scripted history source (null = keyless). Default: Helius from the data layer's pool, if keyed. */
  history?: HistorySource | null;
  pollMs?: number;
  /** Test seam: a fake clock (default: the data layer's, else the system clock). */
  clock?: Clock;
}

export class CopyLive {
  readonly store: FollowStore;
  readonly tracker: WalletTracker;
  private pending: CopyAlert[] = [];
  /** Tier 3: the auto-mirror service, attached by the app once the plan service exists (null = no auto path at all). */
  auto: CopyAuto | null = null;
  private readonly dl: DataLayer | null;
  private readonly clock: Clock;

  constructor(dl: DataLayer | null, opts: CopyLiveOptions = {}) {
    const clock = opts.clock ?? dl?.clock ?? systemClock;
    this.dl = dl;
    this.clock = clock;
    this.store = new FollowStore({ path: opts.followsPath === undefined ? defaultFollowsPath(opts.env) : opts.followsPath, clock });
    const url = dl?.rpcPool.heliusUrl ?? null;
    const history = opts.history !== undefined ? opts.history : (dl && url ? new HeliusHistory(dl.http, url) : null);
    this.tracker = new WalletTracker({
      follows: this.store, history, clock, solUsd: opts.solUsd, pollMs: opts.pollMs,
      onAlert: (a) => { this.pending.push(a); if (this.pending.length > 20) this.pending.splice(0, this.pending.length - 20); if (this.auto) void this.auto.onAlert(a); },
      onChange: () => { this.auto?.tick(); opts.onChange?.('copy'); },
      available: () => (!dl || dl.health.isAvailable('helius') ? { ok: true } : { ok: false, why: `Helius is ${dl.health.state('helius')}; wallet polling paused` }),
    });
  }

  follows(): FollowRecord[] { return this.store.list(); }
  status(): TrackerStatus { return this.tracker.status(); }
  stats(addr: string): WalletStats { return this.tracker.stats(addr); }
  trades(addr: string): WalletTrade[] { return this.tracker.trades(addr); }
  alerts(limit = 50): CopyAlert[] { return this.tracker.alerts(limit); }
  /** Alerts raised since the last call (the loop toasts them). */
  takeAlerts(): CopyAlert[] { const a = this.pending; this.pending = []; return a; }
  now(): number { return this.clock.now(); }

  /**
   * Tier 2: what the mirror checks need for a mint. The screen's numbers come first (the hint); the data layer
   * fills the gaps: decimals from RPC mint info, price / liquidity / age from DexScreener when nothing on screen
   * has them. Never throws; what cannot be learned stays null and the mirror shows it as unknown.
   */
  async mirrorMarket(mint: string, hint: Partial<MirrorMarket> = {}): Promise<MirrorMarket> {
    const m: MirrorMarket = { symbol: hint.symbol ?? null, decimals: hint.decimals ?? null, priceUsd: hint.priceUsd ?? null, priceAt: hint.priceAt ?? null, liqUsd: hint.liqUsd ?? null, mcapUsd: hint.mcapUsd ?? null, ageMs: hint.ageMs ?? null };
    if (!this.dl) return m;
    if (m.decimals === null) { try { m.decimals = (await this.dl.rpc.mintInfo(mint)).decimals; } catch { /* stays unknown */ } }
    if (m.priceUsd === null || m.liqUsd === null || m.ageMs === null || m.decimals === null) {
      try {
        const v = (await this.dl.dexscreener.tokens([mint])).get(mint);
        if (v) {
          if (m.priceUsd === null && v.pair.priceUsd > 0) { m.priceUsd = v.pair.priceUsd; m.priceAt = v.pair.fetchedAt; }
          if (m.liqUsd === null) m.liqUsd = v.pair.liquidityUsd;
          if (m.mcapUsd === null) m.mcapUsd = v.pair.mcap ?? v.pair.fdv;
          if (m.ageMs === null && v.pair.createdAt) m.ageMs = Math.max(0, this.clock.now() - v.pair.createdAt);
          if (m.symbol === null) m.symbol = v.token.symbol;
          if (m.decimals === null && v.token.decimals !== null) m.decimals = v.token.decimals;
        }
      } catch { /* stays unknown */ }
    }
    return m;
  }

  start(): void { this.tracker.start(); }
  stop(): void { this.tracker.stop(); }
}
