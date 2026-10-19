// trenchscope AI SCAN MODE (task-1324) — the pure engine: deterministic triggers, score + reasons,
// thresholds, the scan state machine, analyst caps/cooldowns and the no-hop rule. See DESIGN.md.
//
// Pure: no I/O, no timers, no network. Every method takes `now` and data in and returns a decision
// out; the interactive loop owns the clock, the data and the side effects (opening the coin, starting
// the analyst). Nothing here can reach the trade ticket, the paper wallet or an executor — the only
// runtime import is `buyShare` from live/flow.ts (itself import-free at runtime).
import type { BuySell } from '@dexterm/data';
import { buyShare } from '../live/flow.ts';

export type ScanMode = 'off' | 'scanning' | 'locked' | 'paused';
export type TriggerId = 'vol' | 'flow' | 'fresh' | 'breakout' | 'liq' | 'holders';
export const TRIGGER_IDS: readonly TriggerId[] = ['vol', 'flow', 'fresh', 'breakout', 'liq', 'holders'];

/** Points a fully-strong trigger contributes; a just-fired one contributes half. */
export const WEIGHTS: Readonly<Record<TriggerId, number>> = { vol: 30, flow: 25, fresh: 20, breakout: 20, liq: 15, holders: 15 };

export interface ScanConfig {
  /** A coin is EXCITING at score ≥ minScore with ≥ minTriggers fired. */
  minScore: number;
  minTriggers: number;
  /** Coins with less liquidity are not scored (gate, not a veto). */
  minLiqUsd: number;
  // vol: 5-minute volume vs the coin's own average 5-minute pace
  volX: number; volFullX: number; volMinUsd: number;
  // flow: buy/sell imbalance flip (m5 vs h1 buy share)
  flowShare: number; flowPrevMax: number; flowMinTxns: number; flowFullShare: number;
  // fresh launch with strong early flow
  freshMaxAgeMin: number; freshMinTxns: number; freshShare: number; freshMinVolUsd: number; freshFullTxns: number;
  // breakout from the cached candle range
  breakoutLookback: number; breakoutPct: number; breakoutFullPct: number;
  // liquidity / holder jumps vs the engine's own short ring of observations
  liqJumpPct: number; liqFullPct: number;
  holdersJumpPct: number; holdersJumpMin: number; holdersFullPct: number;
  /** Look-back of the liq/holder ring. */
  windowMs: number;
  /** Veto coins whose mint or freeze authority is still enabled. */
  vetoAuthorities: boolean;
  /** Seconds after start before the first lock (the rings need a baseline). */
  warmupS: number;
  // cost control
  maxAiPerHour: number;
  maxAiPerCoin: number;
  /** Minimum seconds between analyst reads of the locked coin. */
  refreshS: number;
  /** "Materially moved" for a refresh: price %, m5 buy-share points, vol5m factor (or a new trigger). */
  movePct: number; moveFlowPts: number; moveVolX: number;
  /** After a lock ends: that coin may not lock again for coinCooldownS; no lock at all for postLockS. */
  coinCooldownS: number;
  postLockS: number;
  /** Coins shown on the SCANNING ticker. */
  tickerSize: number;
}

export const DEFAULT_SCAN_CONFIG: Readonly<ScanConfig> = Object.freeze({
  minScore: 45, minTriggers: 2, minLiqUsd: 10_000,
  volX: 3, volFullX: 10, volMinUsd: 2_000,
  flowShare: 0.62, flowPrevMax: 0.52, flowMinTxns: 20, flowFullShare: 0.85,
  freshMaxAgeMin: 60, freshMinTxns: 40, freshShare: 0.58, freshMinVolUsd: 5_000, freshFullTxns: 150,
  breakoutLookback: 20, breakoutPct: 2, breakoutFullPct: 10,
  liqJumpPct: 20, liqFullPct: 60,
  holdersJumpPct: 5, holdersJumpMin: 25, holdersFullPct: 25,
  windowMs: 10 * 60_000,
  vetoAuthorities: true,
  warmupS: 30,
  maxAiPerHour: 8, maxAiPerCoin: 4,
  refreshS: 90, movePct: 3, moveFlowPts: 10, moveVolX: 1.5,
  coinCooldownS: 15 * 60, postLockS: 60,
  tickerSize: 5,
});

/** Merge overrides onto the defaults, dropping non-finite numbers (a bad flag never poisons the engine). */
export function scanConfig(over: Partial<ScanConfig> = {}): ScanConfig {
  const out: ScanConfig = { ...DEFAULT_SCAN_CONFIG };
  for (const [k, v] of Object.entries(over) as Array<[keyof ScanConfig, unknown]>) {
    if (!(k in DEFAULT_SCAN_CONFIG)) continue;
    if (typeof DEFAULT_SCAN_CONFIG[k] === 'boolean') { if (typeof v === 'boolean') (out as unknown as Record<string, unknown>)[k] = v; continue; }
    if (typeof v === 'number' && Number.isFinite(v)) (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** One coin as the scan sees it, built from data already in memory (observe.ts). Times are ms. */
export interface ScanObservation {
  mint: string;
  /** Display only (cleaned by the caller); never put into an analyst prompt. */
  symbol: string;
  /** When the data was fetched (the feed row's fetchedAt), else when it was observed. */
  t: number;
  price: number | null;
  vol5m: number | null; vol1h: number | null; vol6h: number | null; vol24: number | null;
  liq: number | null;
  holders: number | null;
  ageMin: number | null;
  /** DexScreener rolling-window txns (the same pair flow.ts reads), when cached. */
  m5: BuySell | null;
  h1: BuySell | null;
  /** Candles already loaded/cached for this coin (oldest first); never fetched for the scan. */
  candles?: ReadonlyArray<{ t: number; h: number; c: number }> | null;
  /** An existing LARP-detector verdict (task-1315), only when one already exists. */
  larp?: string | null;
  mintAuth?: boolean | null;
  freezeAuth?: boolean | null;
}

export interface TriggerHit { id: TriggerId; strength: number; points: number; reason: string }

export interface CoinScore {
  mint: string;
  symbol: string;
  t: number;
  score: number;
  hits: TriggerHit[];
  /** Why the coin may not lock even with a high raw score (LARP verdict, live authority). */
  veto: string | null;
  exciting: boolean;
}

interface RingSample { t: number; liq: number | null; holders: number | null }

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
const pos = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const pct0 = (x: number): string => `${Math.round(x * 100)}%`;

/** `$12.4K` style for reasons (no locale, deterministic). */
export function usd(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

const hit = (id: TriggerId, strength: number, reason: string): TriggerHit => {
  const s = clamp01(strength);
  return { id, strength: s, points: WEIGHTS[id] * (0.5 + 0.5 * s), reason };
};

/** The coin's own average 5-minute volume pace: vol6h/72, else vol1h/12, else vol24/288. */
export function volBaseline(o: Pick<ScanObservation, 'vol1h' | 'vol6h' | 'vol24'>): { per5m: number; basis: '6h' | '1h' | '24h' } | null {
  if (pos(o.vol6h)) return { per5m: o.vol6h / 72, basis: '6h' };
  if (pos(o.vol1h)) return { per5m: o.vol1h / 12, basis: '1h' };
  if (pos(o.vol24)) return { per5m: o.vol24 / 288, basis: '24h' };
  return null;
}

export function volTrigger(o: ScanObservation, cfg: ScanConfig): TriggerHit | null {
  if (!pos(o.vol5m) || o.vol5m < cfg.volMinUsd) return null;
  const b = volBaseline(o);
  if (!b || b.per5m <= 0) return null;
  const ratio = o.vol5m / b.per5m;
  if (ratio < cfg.volX) return null;
  return hit('vol', (ratio - cfg.volX) / Math.max(1e-9, cfg.volFullX - cfg.volX), `vol 5m ${usd(o.vol5m)} = ${ratio.toFixed(1)}× its ${b.basis} pace`);
}

export function flowTrigger(o: ScanObservation, cfg: ScanConfig): TriggerHit | null {
  if (!o.m5 || !o.h1) return null;
  const n5 = o.m5.buys + o.m5.sells;
  const s5 = buyShare(o.m5);
  const s1 = buyShare(o.h1);
  if (s5 === null || s1 === null || n5 < cfg.flowMinTxns) return null;
  if (s5 < cfg.flowShare || s1 > cfg.flowPrevMax) return null;
  return hit('flow', (s5 - cfg.flowShare) / Math.max(1e-9, cfg.flowFullShare - cfg.flowShare), `flow flip: 5m buys ${pct0(s5)} (${o.m5.buys}/${n5}) vs 1h ${pct0(s1)}`);
}

export function freshTrigger(o: ScanObservation, cfg: ScanConfig): TriggerHit | null {
  if (o.ageMin === null || o.ageMin < 0 || o.ageMin > cfg.freshMaxAgeMin || !o.m5) return null;
  const n5 = o.m5.buys + o.m5.sells;
  const s5 = buyShare(o.m5);
  if (s5 === null || n5 < cfg.freshMinTxns || s5 < cfg.freshShare) return null;
  if (!pos(o.vol5m) || o.vol5m < cfg.freshMinVolUsd) return null;
  return hit('fresh', (n5 - cfg.freshMinTxns) / Math.max(1e-9, cfg.freshFullTxns - cfg.freshMinTxns), `fresh launch ${Math.round(o.ageMin)}m old: 5m ${n5} txns, ${pct0(s5)} buys, ${usd(o.vol5m)}`);
}

export function breakoutTrigger(o: ScanObservation, cfg: ScanConfig): TriggerHit | null {
  const cs = o.candles;
  const n = cfg.breakoutLookback;
  if (!cs || n < 1 || cs.length < n + 1) return null;
  const last = cs[cs.length - 1];
  let hi = -Infinity;
  for (let i = cs.length - 1 - n; i < cs.length - 1; i++) hi = Math.max(hi, cs[i].h);
  if (!pos(hi) || !pos(last.c)) return null;
  const p = (last.c / hi - 1) * 100;
  if (p < cfg.breakoutPct) return null;
  return hit('breakout', (p - cfg.breakoutPct) / Math.max(1e-9, cfg.breakoutFullPct - cfg.breakoutPct), `breakout: close +${p.toFixed(1)}% above the ${n}-bar high`);
}

/** Ring samples strictly before `o.t` inside the look-back window. */
function window(ring: readonly RingSample[] | undefined, t: number, ms: number): RingSample[] {
  return (ring ?? []).filter((s) => s.t < t && t - s.t <= ms);
}

export function liqTrigger(o: ScanObservation, ring: readonly RingSample[] | undefined, cfg: ScanConfig): TriggerHit | null {
  if (!pos(o.liq)) return null;
  const prior = window(ring, o.t, cfg.windowMs).filter((s) => pos(s.liq));
  if (!prior.length) return null;
  let lo = prior[0];
  for (const s of prior) if ((s.liq as number) < (lo.liq as number)) lo = s;
  const p = (o.liq / (lo.liq as number) - 1) * 100;
  if (p < cfg.liqJumpPct) return null;
  return hit('liq', (p - cfg.liqJumpPct) / Math.max(1e-9, cfg.liqFullPct - cfg.liqJumpPct), `liquidity +${Math.round(p)}% in ${Math.max(1, Math.round((o.t - lo.t) / 60_000))}m (${usd(lo.liq as number)}→${usd(o.liq)})`);
}

export function holdersTrigger(o: ScanObservation, ring: readonly RingSample[] | undefined, cfg: ScanConfig): TriggerHit | null {
  if (!pos(o.holders)) return null;
  const prior = window(ring, o.t, cfg.windowMs).filter((s) => pos(s.holders));
  if (!prior.length) return null;
  const first = prior[0]; // oldest in the window
  const h0 = first.holders as number;
  const d = o.holders - h0;
  const p = (d / h0) * 100;
  if (p < cfg.holdersJumpPct || d < cfg.holdersJumpMin) return null;
  return hit('holders', (p - cfg.holdersJumpPct) / Math.max(1e-9, cfg.holdersFullPct - cfg.holdersJumpPct), `holders +${d} (+${p.toFixed(1)}%) in ${Math.max(1, Math.round((o.t - first.t) / 60_000))}m`);
}

/** Every trigger for one coin, its score, the veto and whether it is EXCITING. Pure. */
export function scoreCoin(o: ScanObservation, ring: readonly RingSample[] | undefined, cfg: ScanConfig): CoinScore {
  const base = { mint: o.mint, symbol: o.symbol, t: o.t };
  if (!pos(o.liq) || o.liq < cfg.minLiqUsd) return { ...base, score: 0, hits: [], veto: null, exciting: false };
  const hits = [volTrigger(o, cfg), flowTrigger(o, cfg), freshTrigger(o, cfg), breakoutTrigger(o, cfg), liqTrigger(o, ring, cfg), holdersTrigger(o, ring, cfg)]
    .filter((h): h is TriggerHit => h !== null)
    .sort((a, b) => b.points - a.points);
  let veto: string | null = null;
  if (o.larp === 'LARP') veto = 'vetoed: LARP verdict (larp-check)';
  else if (cfg.vetoAuthorities && o.mintAuth === true) veto = 'vetoed: mint authority enabled';
  else if (cfg.vetoAuthorities && o.freezeAuth === true) veto = 'vetoed: freeze authority enabled';
  const raw = Math.min(100, Math.round(hits.reduce((s, h) => s + h.points, 0)));
  const score = veto ? 0 : raw;
  return { ...base, score, hits, veto, exciting: !veto && score >= cfg.minScore && hits.length >= cfg.minTriggers };
}

/** What changed enough since the last read to justify a refresh turn (empty = nothing material). */
export function materialMove(prev: ScanObservation | null, cur: ScanObservation, prevHits: readonly TriggerId[], curHits: readonly TriggerId[], cfg: ScanConfig): string[] {
  if (!prev) return ['first read'];
  const out: string[] = [];
  if (pos(prev.price) && pos(cur.price)) {
    const p = (cur.price / prev.price - 1) * 100;
    if (Math.abs(p) >= cfg.movePct) out.push(`price ${p >= 0 ? '+' : ''}${p.toFixed(1)}%`);
  }
  const a = buyShare(prev.m5), b = buyShare(cur.m5);
  if (a !== null && b !== null && Math.abs(b - a) * 100 >= cfg.moveFlowPts) out.push(`5m buy share ${pct0(a)}→${pct0(b)}`);
  if (pos(prev.vol5m) && pos(cur.vol5m)) {
    const f = cur.vol5m / prev.vol5m;
    if (f >= cfg.moveVolX || f <= 1 / cfg.moveVolX) out.push(`vol 5m ×${f.toFixed(2)}`);
  }
  const fresh = curHits.filter((id) => !prevHits.includes(id));
  if (fresh.length) out.push(`new trigger: ${fresh.join(', ')}`);
  return out;
}

/** The first analyst turn of a lock: the reasons (engine-built text: numbers + fixed words, no token text). */
export function lockQuestion(score: number, hits: readonly TriggerHit[]): string {
  return `SCAN TRIGGER on the SELECTED coin (scan score ${score}/100): ${hits.map((h) => h.reason).join('; ')}. `
    + 'Give your short read now: call · why · levels · risk. Observe only: do not open tickets or navigate.';
}

/** A refresh turn on the warm session while LOCKED. */
export function refreshQuestion(moved: readonly string[]): string {
  return `SCAN REFRESH: the data moved since your last read (${moved.join('; ')}). `
    + 'Give an UPDATED short read and say in one line what changed. Observe only.';
}

export interface ScanLock {
  mint: string;
  symbol: string;
  /** When the lock fired, and the score + reasons that fired it (the WHY strip). */
  at: number;
  score: number;
  hits: TriggerHit[];
  /** The coin's latest score while locked (display only). */
  liveScore: number;
  /** Last analyst read: when it started and the data it was based on. */
  lastReadAt: number;
  lastRead: ScanObservation | null;
  lastHits: TriggerId[];
  /** Reads started for this lock (the lock's first turn included). */
  reads: number;
  /** Last refresh's "what moved" list. */
  moved: string[];
}

export type ScanDecision =
  | { kind: 'lock'; mint: string; symbol: string; score: number; hits: TriggerHit[]; question: string }
  | { kind: 'refresh'; mint: string; symbol: string; moved: string[]; question: string };

export interface ScanUsage { hour: number; hourCap: number; coin: number; coinCap: number; nextFreeInMs: number | null }

const HOUR = 3_600_000;
const RING_MAX = 40;
const MAX_MINTS = 800;
const FORGET_MS = 30 * 60_000;

/**
 * The scan state machine. `observe()` takes the coins the app already has, `tick()` scores them and
 * returns at most one decision (lock a coin / refresh the locked read). Invariants:
 *   - off/paused never decide anything; locked only ever decides a refresh OF THE LOCKED COIN (no hop);
 *   - every decision is one analyst invocation and is only returned when the hourly and per-coin caps
 *     allow it; a refresh additionally needs refreshS since the last read, an idle analyst and a
 *     material data move; a lock needs the warm-up, the post-lock cooldown and the coin's cooldown over.
 */
export class ScanEngine {
  readonly cfg: ScanConfig;
  mode: ScanMode = 'off';
  startedAt: number | null = null;
  lock: ScanLock | null = null;
  /** Top coins by score (excluding vetoed / ineligible), for the SCANNING ticker. */
  ticker: CoinScore[] = [];
  /** Coins scored on the last tick (eligible by liquidity). */
  scanned = 0;
  /** Why nothing locked on the last tick (warming up, cooldown, ai cap …), for the ticker. */
  note: string | null = null;
  private readonly rings = new Map<string, RingSample[]>();
  private readonly latest = new Map<string, ScanObservation>();
  private readonly seenAt = new Map<string, number>();
  private invocations: Array<{ t: number; mint: string }> = [];
  private readonly barredUntil = new Map<string, number>();
  private noLockUntil = 0;

  constructor(cfg: Partial<ScanConfig> = {}) {
    this.cfg = scanConfig(cfg);
  }

  get on(): boolean { return this.mode !== 'off'; }

  /** off → scanning. Returns false when already on. */
  start(now: number): boolean {
    if (this.mode !== 'off') return false;
    this.mode = 'scanning';
    this.startedAt = now;
    this.lock = null;
    this.note = null;
    return true;
  }

  /** Any state → off. The locked coin (if any) gets its cooldown. Returns the mint that was locked. */
  stop(now: number): string | null {
    const was = this.lock?.mint ?? null;
    if (was) this.barredUntil.set(was, now + this.cfg.coinCooldownS * 1000);
    this.mode = 'off';
    this.lock = null;
    this.ticker = [];
    this.note = null;
    this.startedAt = null;
    return was;
  }

  /** locked → paused (the user cancelled the analysis). The coin stays pulled up; nothing else locks. */
  cancelAnalysis(_now: number): boolean {
    if (this.mode !== 'locked') return false;
    this.mode = 'paused';
    return true;
  }

  /** locked/paused → scanning (the "resume scan" key). The released coin is barred; a short global cooldown. */
  resume(now: number): boolean {
    if (this.mode === 'off') return this.start(now);
    if (this.mode === 'scanning') return false;
    if (this.lock) this.barredUntil.set(this.lock.mint, now + this.cfg.coinCooldownS * 1000);
    this.lock = null;
    this.noLockUntil = now + this.cfg.postLockS * 1000;
    this.mode = 'scanning';
    return true;
  }

  /** Feed the latest observations (the feed rows + the open token). Cheap; keeps a short ring per coin. */
  observe(obs: readonly ScanObservation[], now: number): void {
    for (const o of obs) {
      if (!o.mint) continue;
      this.latest.set(o.mint, o);
      this.seenAt.set(o.mint, now);
      const ring = this.rings.get(o.mint) ?? [];
      const last = ring[ring.length - 1];
      if (!last || o.t > last.t) {
        ring.push({ t: o.t, liq: o.liq, holders: o.holders });
        while (ring.length > RING_MAX || (ring.length > 1 && o.t - ring[0].t > this.cfg.windowMs * 1.5)) ring.shift();
        this.rings.set(o.mint, ring);
      }
    }
    // forget coins nobody has shown us for a while (bounded memory)
    if (this.latest.size > MAX_MINTS || this.seenAt.size > MAX_MINTS) {
      for (const [m, t] of this.seenAt) if (now - t > FORGET_MS || this.latest.size > MAX_MINTS) { this.seenAt.delete(m); this.latest.delete(m); this.rings.delete(m); }
    }
  }

  /** Invocations in the last hour (overall and for one coin), and when the next slot frees. */
  usage(now: number, mint?: string): ScanUsage {
    this.invocations = this.invocations.filter((x) => now - x.t < HOUR);
    const coin = mint ? this.invocations.filter((x) => x.mint === mint).length : 0;
    const full = this.invocations.length >= this.cfg.maxAiPerHour;
    return {
      hour: this.invocations.length, hourCap: this.cfg.maxAiPerHour, coin, coinCap: this.cfg.maxAiPerCoin,
      nextFreeInMs: full && this.invocations.length ? Math.max(0, HOUR - (now - this.invocations[0].t)) : null,
    };
  }

  private canInvoke(now: number, mint: string): boolean {
    const u = this.usage(now, mint);
    return u.hour < u.hourCap && u.coin < u.coinCap;
  }

  /** Score one observed coin with its ring (exposed for the ticker/tests). */
  score(mint: string): CoinScore | null {
    const o = this.latest.get(mint);
    return o ? scoreCoin(o, this.rings.get(mint), this.cfg) : null;
  }

  /** Score everything, update the ticker, and return at most one decision. */
  tick(now: number, ctx: { analystBusy: boolean; holdLock?: boolean } = { analystBusy: false }): ScanDecision | null {
    if (this.mode === 'off') return null;
    const scored: CoinScore[] = [];
    for (const [m, o] of this.latest) {
      if (!pos(o.liq) || o.liq < this.cfg.minLiqUsd) continue;
      scored.push(scoreCoin(o, this.rings.get(m), this.cfg));
    }
    this.scanned = scored.length;
    scored.sort((a, b) => b.score - a.score || b.hits.length - a.hits.length || (a.mint < b.mint ? -1 : 1));
    this.ticker = scored.filter((s) => !s.veto && s.score > 0).slice(0, this.cfg.tickerSize);

    if (this.mode === 'paused') { this.note = 'analysis cancelled · R resume scan · Z stop'; return null; }

    if (this.mode === 'locked' && this.lock) {
      // NO-HOP: only the locked coin is ever considered here, whatever else scores higher.
      const lock = this.lock;
      const o = this.latest.get(lock.mint);
      if (!o) return null;
      const cur = scoreCoin(o, this.rings.get(lock.mint), this.cfg);
      lock.liveScore = cur.score;
      if (ctx.analystBusy) { this.note = 'reading…'; return null; }
      const wait = lock.lastReadAt + this.cfg.refreshS * 1000 - now;
      if (wait > 0) { this.note = `next read ≥ ${Math.ceil(wait / 1000)}s`; return null; }
      const curIds = cur.hits.map((h) => h.id);
      const moved = materialMove(lock.lastRead, o, lock.lastHits, curIds, this.cfg);
      if (!moved.length) { this.note = 'holding · data flat since last read'; return null; }
      if (!this.canInvoke(now, lock.mint)) { this.note = this.capNote(now, lock.mint); return null; }
      this.invocations.push({ t: now, mint: lock.mint });
      lock.lastReadAt = now;
      lock.lastRead = o;
      lock.lastHits = curIds;
      lock.reads += 1;
      lock.moved = moved;
      this.note = null;
      return { kind: 'refresh', mint: lock.mint, symbol: lock.symbol, moved, question: refreshQuestion(moved) };
    }

    // SCANNING
    if (this.startedAt !== null && now - this.startedAt < this.cfg.warmupS * 1000) {
      this.note = `warming up ${Math.ceil((this.cfg.warmupS * 1000 - (now - this.startedAt)) / 1000)}s`;
      return null;
    }
    if (now < this.noLockUntil) { this.note = `cooldown ${Math.ceil((this.noLockUntil - now) / 1000)}s`; return null; }
    // The UI is busy (a ticket, an overlay, an editor, a half-typed question): never pull a coin up now.
    if (ctx.holdLock) { this.note = 'holding: you are busy'; return null; }
    let capped: string | null = null;
    const pick = scored.find((s) => {
      if (!s.exciting) return false;
      if ((this.barredUntil.get(s.mint) ?? 0) > now) return false;
      if (!this.canInvoke(now, s.mint)) { capped ??= s.mint; return false; }
      return true;
    });
    if (!pick) { this.note = capped ? this.capNote(now, capped) : null; return null; }
    const o = this.latest.get(pick.mint) as ScanObservation;
    this.invocations.push({ t: now, mint: pick.mint });
    this.mode = 'locked';
    this.lock = {
      mint: pick.mint, symbol: pick.symbol, at: now, score: pick.score, hits: pick.hits, liveScore: pick.score,
      lastReadAt: now, lastRead: o, lastHits: pick.hits.map((h) => h.id), reads: 1, moved: [],
    };
    this.note = null;
    return { kind: 'lock', mint: pick.mint, symbol: pick.symbol, score: pick.score, hits: pick.hits, question: lockQuestion(pick.score, pick.hits) };
  }

  private capNote(now: number, mint: string): string {
    const u = this.usage(now, mint);
    if (u.hour >= u.hourCap) return `ai cap ${u.hour}/${u.hourCap} per hour${u.nextFreeInMs !== null ? ` · next in ${Math.ceil(u.nextFreeInMs / 60_000)}m` : ''}`;
    return `coin ai cap ${u.coin}/${u.coinCap} per hour`;
  }
}
