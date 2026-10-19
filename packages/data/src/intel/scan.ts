// Wallet-intel SCAN orchestrator (task-1340): two depth tiers over the existing RPC pool + the Helius history
// adapter, every call through the limiter / health registry / credit meter, every immutable fact cached.
//
//   light  (token opened)   top-20 accounts → owners → owner kinds, funders for the largest 7 wallets, launch window
//                           100 txs            ≈ 1 + 1 + 1 + 7×10 + 10 = 83 Helius credits (less with the funder cache)
//   deep   (watchlist coin) same, funders for every wallet in the top sample (≤ 20), launch window 300 txs
//                           ≈ 3 + 20×10 + 30 = 233 credits; the design's "top-100 + 1,000 txs" tier waits for DAS paging
//
// FREE-FOREVER: keyless, the scan still runs on the public RPC pool (top accounts + owner kinds + static labels)
// and says plainly that funders and the launch window need a free Helius key; when even the ranked holder list
// is unavailable the result is `unavailable` with the reason, never a fake picture. Nothing here signs or trades.
import type { Cache } from '../cache.ts';
import type { Clock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import type { HealthRegistry } from '../health.ts';
import type { HttpClient } from '../http.ts';
import type { RpcPool } from '../rpc-pool.ts';
import type { TokenDetail } from '../detail.ts';
import type { CreditMeter } from '../credits.ts';
import { HeliusHistory } from './helius-history.ts';
import { analyze, type IntelAnalysis, type IntelRaw, type RawTx, type OwnerMeta, INTEL_KNOWN_OWNERS } from './rules.ts';
import { SYSTEM_PROGRAM } from '../trade/tx-decode.ts';

export type ScanDepth = 'light' | 'deep';

export const SCAN_DEPTHS: Readonly<Record<ScanDepth, { funders: number; launchTxs: number }>> = {
  light: { funders: 7, launchTxs: 100 },
  deep: { funders: 20, launchTxs: 300 },
};

/** Cache namespaces. Funders are immutable (cached a year); launch windows too (first N txs never change). */
const NS = { funder: 'intel:funder', launch: 'intel:launch', scan: 'intel:scan', ownerMeta: 'intel:owner' } as const;
const FUNDER_TTL_MS = 365 * 86_400_000;
const LAUNCH_TTL_MS = 30 * 86_400_000;
const OWNER_META_TTL_MS = 86_400_000;
export const SCAN_TTL_MS = 60_000;

export interface ScanOk {
  state: 'ok';
  depth: ScanDepth;
  analysis: IntelAnalysis;
  /** Which sources answered: the holder list's source and whether history ran. */
  via: { holders: string; history: 'helius' | null };
  /** Honest degradation note when the history leg could not run (keyless, credit cap, Helius down). */
  degraded: string | null;
  fetchedAt: number;
  fromCache: boolean;
}

export interface ScanUnavailable {
  state: 'unavailable';
  depth: ScanDepth;
  reason: string;
  /** How to get the full picture (doctor wording). */
  fix: string | null;
  fetchedAt: number;
}

export type ScanResult = ScanOk | ScanUnavailable;

export interface WalletIntelDeps {
  cache: Cache;
  http: HttpClient;
  pool: RpcPool;
  detail: TokenDetail;
  health: HealthRegistry;
  credits?: CreditMeter | null;
  clock?: Clock;
  /** Test seam: override the history adapter (null = no Helius). Default: from the pool's helius endpoint. */
  history?: HeliusHistory | null;
}

export const KEY_FIX = 'free Helius key → ~/.dexterm/helius.key (1M credits/month, no card; `trenchscope doctor` walks through it)';

export class WalletIntel {
  private readonly cache: Cache;
  private readonly pool: RpcPool;
  private readonly detail: TokenDetail;
  private readonly health: HealthRegistry;
  private readonly credits: CreditMeter | null;
  private readonly clock: Clock;
  private readonly history: HeliusHistory | null;
  private readonly inflight = new Map<string, Promise<ScanResult>>();

  constructor(deps: WalletIntelDeps) {
    this.cache = deps.cache;
    this.pool = deps.pool;
    this.detail = deps.detail;
    this.health = deps.health;
    this.credits = deps.credits ?? null;
    this.clock = deps.clock ?? systemClock;
    if (deps.history !== undefined) this.history = deps.history;
    else { const url = deps.pool.heliusUrl; this.history = url ? new HeliusHistory(deps.http, url) : null; }
  }

  /** True when the history leg (funders + launch window) can run right now. */
  historyAvailable(): { ok: true } | { ok: false; why: string } {
    if (!this.history) return { ok: false, why: `funders and launch window need a ${KEY_FIX}` };
    if (!this.health.isAvailable('helius')) return { ok: false, why: `Helius is ${this.health.state('helius')} (${this.credits && this.credits.level() === 'degraded' ? 'daily credit budget spent' : 'rate limited or down'}); funders and launch window paused` };
    return { ok: true };
  }

  /**
   * Scan one mint. Results are cached SCAN_TTL_MS per (mint, depth) and in-flight scans coalesce, so a 30 fps
   * UI asking every frame costs nothing. Never throws: every failure is an `unavailable` result with a reason.
   */
  scan(mint: string, depth: ScanDepth = 'light', opts: { force?: boolean } = {}): Promise<ScanResult> {
    const key = `${mint}|${depth}`;
    if (!opts.force) {
      const hit = this.cache.get<ScanOk>(NS.scan, key);
      if (hit && !hit.stale) return Promise.resolve({ ...hit.value, fromCache: true });
    }
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.run(mint, depth).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async run(mint: string, depth: ScanDepth): Promise<ScanResult> {
    const now = this.clock.now();
    const plan = SCAN_DEPTHS[depth];
    // ---- B–D: ranked holder list through the existing TokenDetail (cached 60 s, pool rotation, aggregate fallback)
    let top;
    try { top = await this.detail.holders(mint); } catch (e) {
      const keyless = !this.pool.hasKeyed;
      return { state: 'unavailable', depth, reason: `holder list unavailable: ${msg(e)}`, fix: keyless ? KEY_FIX : null, fetchedAt: now };
    }
    const th = top.value;
    if (th.aggregateOnly || th.holders.length === 0) {
      return { state: 'unavailable', depth, reason: th.aggregateOnly ? 'no RPC endpoint serves the ranked holder list (public RPCs throttle getTokenLargestAccounts)' : 'the holder list came back empty', fix: this.pool.hasKeyed ? null : KEY_FIX, fetchedAt: now };
    }
    const owners: Record<string, string> = {};
    for (const h of th.holders) if (h.owner) owners[h.tokenAccount] = h.owner;
    const ownerList = [...new Set(Object.values(owners))];
    // owner kinds (System-owned wallet vs program-owned vault); cached a day per owner
    const ownerMeta: Record<string, OwnerMeta> = {};
    const missing: string[] = [];
    for (const o of ownerList) { const c = this.cache.get<OwnerMeta>(NS.ownerMeta, o); if (c && !c.stale) ownerMeta[o] = c.value; else missing.push(o); }
    if (missing.length) {
      try {
        const m = await this.pool.accountMeta(missing);
        for (const [o, meta] of m) { ownerMeta[o] = meta; this.cache.set(NS.ownerMeta, o, meta, { ttlMs: OWNER_META_TTL_MS, source: this.pool.primary.source }); }
      } catch { /* kinds stay unknown: labels fall back to the static list only */ }
    }
    // ---- E–F: funders + launch window (Helius only)
    const funding: Record<string, RawTx[]> = {};
    let launch: RawTx[] = [];
    let launchMore = false;
    let degraded: string | null = null;
    let history: 'helius' | null = null;
    const hist = this.historyAvailable();
    if (!hist.ok) degraded = hist.why;
    else {
      history = 'helius';
      const wallets = ownerList.filter((o) => { const m = ownerMeta[o]; return (!m || m.programOwner === SYSTEM_PROGRAM || !m.exists) && !INTEL_KNOWN_OWNERS[o]; }).slice(0, plan.funders);
      const errors: string[] = [];
      for (const w of wallets) {
        const c = this.cache.get<RawTx[]>(NS.funder, w);
        if (c) { funding[w] = c.value; continue; } // immutable: stale is fine
        try {
          const page = await this.history!.firstTxs(w);
          funding[w] = page.data;
          this.cache.set(NS.funder, w, page.data, { ttlMs: FUNDER_TTL_MS, source: 'helius' });
        } catch (e) { errors.push(msg(e)); if (errors.length >= 2) break; } // two failures: stop spending
      }
      const lk = `${mint}|${plan.launchTxs}`;
      const lc = this.cache.get<{ data: RawTx[]; more: boolean }>(NS.launch, lk);
      if (lc) { launch = lc.value.data; launchMore = lc.value.more; }
      else {
        try {
          const page = await this.history!.launchWindow(mint, plan.launchTxs);
          launch = page.data; launchMore = page.paginationToken !== null;
          this.cache.set(NS.launch, lk, { data: launch, more: launchMore }, { ttlMs: LAUNCH_TTL_MS, source: 'helius' });
        } catch (e) { errors.push(`launch window: ${msg(e)}`); }
      }
      if (errors.length) degraded = `history partial (${errors[0]})`;
    }
    // Raw amounts: the holder list carries whole-token floats and a bigint-exact pct; rebuild base units from
    // pct × supply so an 18-digit supply keeps its digits (the rules only ever compare shares).
    const supply = BigInt(th.supply);
    const raw: IntelRaw = {
      mint, supply: th.supply, decimals: th.decimals,
      largest: th.holders.map((h) => ({ address: h.tokenAccount, amount: (supply > 0n ? (BigInt(Math.round(h.pct * 1e6)) * supply) / 100_000_000n : 0n).toString() })),
      owners, ownerMeta, funding, launch, launchMore,
    };
    const analysis = analyze(raw);
    const ok: ScanOk = { state: 'ok', depth, analysis, via: { holders: th.source, history }, degraded, fetchedAt: this.clock.now(), fromCache: false };
    this.cache.set(NS.scan, `${mint}|${depth}`, ok, { ttlMs: SCAN_TTL_MS, source: th.source });
    return ok;
  }
}

function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
