// Fast lane: real-time on-chain price for the few tokens the user is actually looking at (SPEC §3.9,
// task-1312). A token's lane is a property of attention: the open token, the watchlist and fresh pump
// launches are priced by push (accountSubscribe on their pump.fun bonding-curve account, price computed
// on-chain, sub-second); everything else stays on the slow (poll) lane. This coordinator owns:
//   - the fast set (capped — see FAST_LANE_CAP) and each mint's resolved PriceAccount,
//   - one shared SolanaWsClient multiplexing every subscription on one connection,
//   - an initial seed (one batched getMultipleAccounts through the RPC pool) so a price shows at once,
//   - endpoint failover (keyed Helius-ws first, keyless public RPC ws as the fallback) and graceful
//     degradation to the slow lane when no stream is available or the Helius credit budget is spent,
//   - honest lane/badge state: laneFor()/badgeFor() report POLL whenever the stream is not actually
//     delivering that token (down, not pump.fun, migrated, or over the cap).
//
// Price USD comes from an injected SOL/USD getter (the slow lane already fetches it); the on-chain decode
// only yields SOL. Never logs an endpoint URL (may carry a key).

import type { Clock } from './clock.ts';
import { systemClock } from './clock.ts';
import type { CreditMeter } from './credits.ts';
import type { HealthRegistry } from './health.ts';
import type { Lane, PriceAccount, PricePoint, SourceId } from './model.ts';
import { decodeBondingCurve, type BondingCurve } from './sources/pump-curve.ts';
import { isPumpMint, pumpBondingCurve } from './sources/pda.ts';
import { SolanaWsClient, type AccountUpdate, type SolanaWsStatus } from './sources/solana-ws.ts';
import type { WsFactory } from './sources/pumpportal.ts';

/**
 * Max simultaneous fast-lane subscriptions. Chosen for the free tier: one shared WS connection
 * multiplexes them (SPEC §3.9.4), each subscription only fires on an account change (cheap), the Helius
 * credit meter bounds total spend regardless, and the keyless public RPC WS has tight undocumented
 * limits — so a conservative cap of 24 comfortably covers the open token + a 5–20 watchlist + a few
 * fresh launches. Tokens past the cap simply stay on the slow lane (honest POLL badge), never dropped.
 */
export const FAST_LANE_CAP = 24;

/** How long after the last push a token is still considered "streaming" for the LIVE badge. */
export const LIVE_FRESHNESS_MS = 90_000;
/** Rotate to the next endpoint after this many consecutive WS failures. */
const ROTATE_AFTER_FAILURES = 3;

export interface FastLaneEndpoint {
  /** ws(s):// URL; may carry an api-key — never log it. */
  url: string;
  source: Extract<SourceId, 'solana-ws' | 'helius-ws'>;
  keyed: boolean;
  /** Safe-to-print label (host + plan). */
  label: string;
}

/** The slice of RpcPool the fast lane uses for seeding (rotation/failover live inside the pool). */
export interface SeedSource {
  accountsRaw(accounts: string[], commitment?: 'processed' | 'confirmed' | 'finalized'): Promise<{ data: Map<string, string | null>; fetchedAt: number }>;
}

export interface FastLaneOptions {
  rpcPool: SeedSource;
  health: HealthRegistry;
  clock?: Clock;
  credits?: CreditMeter | null;
  /** Ordered WS endpoints, keyed first. The fast lane uses the first and fails over to the next. */
  endpoints: FastLaneEndpoint[];
  /** Current SOL/USD (the slow lane already tracks it); null when unknown. */
  solUsd: () => number | null;
  /** Fires for every fast-lane price (seed + each push). */
  onPrice?: (p: PricePoint) => void;
  onStatus?: (s: FastLaneStatus) => void;
  ws?: WsFactory;
  cap?: number;
}

export interface FastLaneStatus {
  /** True while a stream is attached (even if reconnecting). */
  active: boolean;
  endpoint: string;
  keyed: boolean;
  wsState: SolanaWsStatus['state'];
  /** Accounts with a live server subscription right now (the "subscription count"). */
  subscriptions: number;
  /** Mints in the fast set (desired). */
  tracked: number;
  /** Mints actually streaming (fast lane right now). */
  live: number;
  failures: number;
  lastError: string | null;
}

interface Tracked {
  mint: string;
  priceAccount: PriceAccount;
  lastTickAt: number | null;
  lastPrice: PricePoint | null;
  /** Last decoded bonding curve (task-1404: the live-signals binding reads bonding progress / reserves from it). */
  lastCurve: BondingCurve | null;
  /** When `lastCurve` was decoded (local ms). */
  lastCurveAt: number | null;
  /** Set once a decoded curve reports `complete` (migrated): on-chain curve price is no longer valid. */
  migrated: boolean;
}

export class FastLane {
  private readonly opts: FastLaneOptions;
  private readonly clock: Clock;
  private readonly cap: number;
  private readonly tracked = new Map<string, Tracked>();
  private readonly byAccount = new Map<string, string>(); // price account -> mint
  private endpoints: FastLaneEndpoint[];
  private epIndex = 0;
  private ws: SolanaWsClient | null = null;
  private started = false;
  private switching = false;
  private lastError: string | null = null;

  constructor(opts: FastLaneOptions) {
    if (opts.endpoints.length === 0) throw new Error('FastLane needs at least one WS endpoint');
    this.opts = opts;
    this.clock = opts.clock ?? systemClock;
    this.cap = opts.cap ?? FAST_LANE_CAP;
    this.endpoints = opts.endpoints;
  }

  get endpoint(): FastLaneEndpoint {
    return this.endpoints[this.epIndex];
  }

  /** Attach the stream and subscribe whatever is already tracked. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.openWs();
  }

  stop(): void {
    this.started = false;
    this.ws?.stop();
    this.ws = null;
    this.emit();
  }

  private openWs(): void {
    const ep = this.endpoint;
    const meter = ep.keyed ? this.opts.credits ?? null : null;
    this.ws = new SolanaWsClient({
      url: ep.url,
      source: ep.source,
      clock: this.clock,
      health: this.opts.health,
      ws: this.opts.ws,
      onAccount: (u) => this.onAccount(u),
      onBytes: meter ? (b) => { meter.chargeBytes(b); this.maybeDegrade(); } : undefined,
      onStatus: (s) => this.onWsStatus(s),
    });
    this.ws.start();
    // (Re)subscribe everything already tracked on the new socket.
    this.ws.setAccounts([...this.byAccount.keys()]);
    // Seed an initial price for everything tracked (so a value shows before the first push).
    void this.seed([...this.tracked.keys()]);
    this.emit();
  }

  private onWsStatus(s: SolanaWsStatus): void {
    if (this.switching || s.state === 'stopped') return; // ignore events we caused while swapping endpoints
    if (s.lastError) this.lastError = s.lastError;
    // Endpoint keeps failing: fail over to the next one (keyed → public keyless).
    if (s.failures >= ROTATE_AFTER_FAILURES && this.endpoints.length > 1) this.rotate('repeated ws failures');
    this.emit();
  }

  /** Swap to `index`, preserving the desired subscription set. Reentrancy-guarded (openWs/stop emit). */
  private switchTo(index: number): void {
    if (index === this.epIndex || index < 0 || index >= this.endpoints.length) return;
    this.switching = true;
    try {
      this.epIndex = index;
      this.ws?.stop();
      this.ws = null;
      if (this.started) this.openWs();
    } finally {
      this.switching = false;
    }
    this.emit();
  }

  /** Switch to the next endpoint, preserving the desired subscription set. */
  private rotate(_reason: string): void {
    if (this.endpoints.length <= 1) return;
    this.switchTo((this.epIndex + 1) % this.endpoints.length);
  }

  /** On Helius credit exhaustion, drop to the first keyless endpoint so the lane keeps streaming free. */
  private maybeDegrade(): void {
    const credits = this.opts.credits;
    if (this.switching || !credits || !this.endpoint.keyed) return;
    if (credits.level() !== 'degraded') return;
    const keyless = this.endpoints.findIndex((e) => !e.keyed);
    if (keyless >= 0) this.switchTo(keyless);
  }

  /**
   * Resolve a mint's on-chain pricing account. A known bonding-curve (from a PumpPortal Create event) is
   * used directly; otherwise a pump.fun mint's curve is derived as a PDA. Non-pump mints are `unknown`
   * and stay on the slow lane.
   */
  resolvePriceAccount(mint: string, curveHint?: string | null): PriceAccount {
    if (curveHint) return { mint, kind: 'pump-curve', curve: curveHint };
    if (isPumpMint(mint)) {
      try {
        return { mint, kind: 'pump-curve', curve: pumpBondingCurve(mint) };
      } catch {
        return { mint, kind: 'unknown' };
      }
    }
    return { mint, kind: 'unknown' };
  }

  /**
   * Add a mint to the fast set. Returns true when it was promoted to the fast lane (streamable and within
   * the cap), false when it must stay on the slow lane. Idempotent for an already-tracked mint.
   */
  track(mint: string, curveHint?: string | null): boolean {
    const existing = this.tracked.get(mint);
    if (existing) return existing.priceAccount.kind !== 'unknown' && !existing.migrated;
    const priceAccount = this.resolvePriceAccount(mint, curveHint);
    if (priceAccount.kind === 'unknown' || !priceAccount.curve) return false;
    if (this.tracked.size >= this.cap) return false; // over the cap: stay slow, never drop
    const t: Tracked = { mint, priceAccount, lastTickAt: null, lastPrice: null, lastCurve: null, lastCurveAt: null, migrated: false };
    this.tracked.set(mint, t);
    this.byAccount.set(priceAccount.curve, mint);
    this.ws?.subscribe(priceAccount.curve);
    if (this.started) void this.seed([mint]);
    this.emit();
    return true;
  }

  untrack(mint: string): void {
    const t = this.tracked.get(mint);
    if (!t) return;
    this.tracked.delete(mint);
    if (t.priceAccount.curve) {
      this.byAccount.delete(t.priceAccount.curve);
      this.ws?.unsubscribe(t.priceAccount.curve);
    }
    this.emit();
  }

  /**
   * Replace the fast set wholesale (open token + watchlist + fresh launches). `curveHints` carries known
   * curves (e.g. from Create events) so no PDA derivation is needed. Order matters when over the cap:
   * earlier mints win (callers pass the open token first).
   */
  setTracked(mints: Iterable<string>, curveHints?: Map<string, string>): void {
    const next = [...mints];
    const nextSet = new Set(next);
    for (const mint of [...this.tracked.keys()]) if (!nextSet.has(mint)) this.untrack(mint);
    for (const mint of next) this.track(mint, curveHints?.get(mint) ?? null);
  }

  /** Seed first prices for `mints` via one batched getMultipleAccounts (through the pool). Best-effort. */
  private async seed(mints: string[]): Promise<void> {
    const curves: string[] = [];
    for (const m of mints) {
      const t = this.tracked.get(m);
      if (t?.priceAccount.curve) curves.push(t.priceAccount.curve);
    }
    if (curves.length === 0) return;
    let data: Map<string, string | null>;
    try {
      ({ data } = await this.opts.rpcPool.accountsRaw(curves, 'processed'));
    } catch {
      return; // the first push will supply a price
    }
    for (const [account, base64] of data) {
      if (base64) this.ingest(account, null, base64, this.clock.now(), true);
    }
  }

  private onAccount(u: AccountUpdate): void {
    this.ingest(u.account, u.slot, u.base64, u.receivedAt, false);
  }

  /** Decode a curve account to a PricePoint and emit it. `seed` marks the initial (non-push) value. */
  private ingest(account: string, slot: number | null, base64: string, t: number, seed: boolean): void {
    const mint = this.byAccount.get(account);
    if (!mint) return;
    const tracked = this.tracked.get(mint);
    if (!tracked) return;
    const curve = decodeBondingCurve(base64);
    if (!curve) return;
    // task-1404: keep the decoded curve (reserves / complete) so the live-signals binding can read bonding
    // progress and migration from the same push, not just the price.
    tracked.lastCurve = curve;
    tracked.lastCurveAt = t;
    if (curve.priceSol == null) return;
    if (curve.complete) {
      // Migrated to a DEX pool: the bonding-curve price is stale. Demote to the slow lane honestly;
      // AMM-pool on-chain pricing is a later card (SPEC §3.9.4).
      tracked.migrated = true;
      this.emit();
      return;
    }
    const solUsd = this.opts.solUsd();
    const point: PricePoint = {
      mint,
      priceSol: curve.priceSol,
      priceUsd: solUsd != null && Number.isFinite(solUsd) ? curve.priceSol * solUsd : null,
      slot,
      t,
      source: 'onchain-curve',
      lane: 'fast',
    };
    tracked.lastPrice = point;
    if (!seed) tracked.lastTickAt = t;
    this.opts.onPrice?.(point);
    if (!seed) this.emit();
  }

  /** The lane a mint is on right now (honest): fast only when its curve is actually streaming. */
  laneFor(mint: string): Lane {
    return this.isLive(mint) ? 'fast' : 'slow';
  }

  /** Honest per-row/panel badge: LIVE when a fresh on-chain push is flowing, else POLL. */
  badgeFor(mint: string): 'LIVE' | 'POLL' {
    return this.isLive(mint) ? 'LIVE' : 'POLL';
  }

  private isLive(mint: string): boolean {
    const t = this.tracked.get(mint);
    if (!t || t.migrated || t.priceAccount.kind === 'unknown' || !t.priceAccount.curve) return false;
    if (!this.ws || this.ws.getStatus().state !== 'open') return false;
    // Keyed stream with the credit budget spent is not actually delivering: POLL.
    if (this.endpoint.keyed && this.opts.credits && this.opts.credits.level() === 'degraded') return false;
    // This specific curve must have a live server subscription (its own ack received).
    if (!this.ws.isActive(t.priceAccount.curve)) return false;
    // LIVE means a real on-chain push arrived recently; a seed-only or stale value is honestly POLL.
    return t.lastTickAt != null && this.clock.now() - t.lastTickAt <= LIVE_FRESHNESS_MS;
  }

  /** Last fast-lane price for a mint, or null. */
  price(mint: string): PricePoint | null {
    return this.tracked.get(mint)?.lastPrice ?? null;
  }

  /**
   * Last decoded bonding curve for a mint and when it was decoded (task-1404). The live-signals binding reads
   * bonding progress + `complete` from it. null when the mint is not tracked or no push/seed has decoded yet.
   */
  curve(mint: string): { curve: BondingCurve; at: number } | null {
    const t = this.tracked.get(mint);
    return t && t.lastCurve && t.lastCurveAt != null ? { curve: t.lastCurve, at: t.lastCurveAt } : null;
  }

  /**
   * Last fast-lane USD price, recomputed from the stored on-chain SOL price and the *current* SOL/USD —
   * so a tick that arrived before SOL/USD was known still shows a USD value once the rate lands. Null
   * when there is no tick yet or no SOL/USD.
   */
  priceUsd(mint: string): number | null {
    const last = this.tracked.get(mint)?.lastPrice;
    if (!last) return null;
    const s = this.opts.solUsd();
    if (s != null && Number.isFinite(s)) return last.priceSol * s;
    return last.priceUsd;
  }

  isTracked(mint: string): boolean {
    return this.tracked.has(mint);
  }

  status(): FastLaneStatus {
    const ws = this.ws?.getStatus();
    let live = 0;
    for (const m of this.tracked.keys()) if (this.isLive(m)) live++;
    return {
      active: this.started && !!this.ws,
      endpoint: this.endpoint.label,
      keyed: this.endpoint.keyed,
      wsState: ws?.state ?? 'idle',
      subscriptions: ws?.active ?? 0,
      tracked: this.tracked.size,
      live,
      failures: ws?.failures ?? 0,
      lastError: this.lastError,
    };
  }

  private emit(): void {
    this.opts.onStatus?.(this.status());
  }
}
