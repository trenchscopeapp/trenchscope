// trenchscope — BUY/SELL FLOW for the live token screen (task-1323 item 6). Replaces the slow trade tape
// as the default lower-right panel with buy-vs-sell across timeframes, computed ONLY from data the app
// already fetches — no new source, no extra request:
//   1m              ← the GeckoTerminal trade tape TokenLive already polls (last 60 s, counted by side,
//                     USD summed per side); the previous minute comes from the same tape.
//   5m / 1h / 6h / 24h ← DexScreener pair `txns.{m5,h1,h6,h24}.{buys,sells}` + `volume.*` — the pair
//                     `store.enrich` already cached for this mint on the same refresh that set the
//                     header price. Read from the cache (no network); DexScreener does not split volume
//                     by side, so these rows show total USD volume.
// "Trend" compares the window's buy share with the PREVIOUS same-length window. For the DexScreener
// windows that is a sample of the same rolling window taken one window-length earlier, kept in a short
// in-memory ring per mint; until that sample exists the row says `wait <time left>` instead of an arrow.
import type { BuySell, ByWindow, Cache, DsTokenView, Window } from '@dexterm/data';
import type { FlowPanelRow, FlowTrendCell } from '@dexterm/tui';
import type { LiveTrade, PanelStatus } from './token.ts';

/** Cache namespace `Store.enrich` writes DexScreener token views under (store.ts `NS.ds`). A test pins it. */
export const DS_TOKEN_CACHE_NS = 'ds:token';
/** TokenLive keeps the newest 60 tape trades (live/token.ts `slice(0, 60)`); a full tape may not reach back a whole minute. */
export const TAPE_CAP = 60;
/** A buy-share move smaller than this (percentage points) is "flat". */
export const FLAT_PTS = 2;
/** A previous-window sample may be off by this fraction of the window length. */
export const PREV_TOLERANCE = 0.25;
/** Minimum spacing between ring samples; older samples thin out to ~2 % of their age. */
export const MIN_SAMPLE_GAP_MS = 5_000;
const THIN_FRACTION = 0.02;
const MAX_AGE_MS = 25 * 3_600_000;
const MAX_SAMPLES = 1_000;

export interface FlowWindowDef { label: string; ms: number; ds: Window | null }

/** The panel's timeframes, shortest first. `ds: null` = derived from the trade tape. */
export const FLOW_WINDOWS: readonly FlowWindowDef[] = [
  { label: '1m', ms: 60_000, ds: null },
  { label: '5m', ms: 300_000, ds: 'm5' },
  { label: '1h', ms: 3_600_000, ds: 'h1' },
  { label: '6h', ms: 21_600_000, ds: 'h6' },
  { label: '24h', ms: 86_400_000, ds: 'h24' },
];

/** One DexScreener observation of a pair's rolling windows. `t` = when DexScreener answered. */
export interface FlowSample {
  t: number;
  txns: ByWindow<BuySell>;
  volume: ByWindow<number | null>;
}

/** Buy share of a window (0..1), null when nothing traded. */
export function buyShare(c: BuySell | null): number | null {
  if (!c) return null;
  const n = c.buys + c.sells;
  return n > 0 ? c.buys / n : null;
}

/** Trend of the current window vs the previous one: buy-share change in percentage points. */
export function trendCell(cur: BuySell | null, prev: BuySell | null, flatPts = FLAT_PTS): FlowTrendCell {
  const a = buyShare(cur);
  const b = buyShare(prev);
  if (a === null || b === null) return { na: 'no trades' };
  const deltaPts = Math.round((a - b) * 100);
  if (Math.abs((a - b) * 100) < flatPts) return { dir: 0, deltaPts };
  return { dir: a > b ? 1 : -1, deltaPts };
}

/** `45s` · `3m` · `2h` · `23h` (rounded up: never says 0 while still waiting). */
export function fmtWait(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.ceil(m / 60)}h`;
}

export interface TapeWindow extends BuySell {
  buyUsd: number;
  sellUsd: number;
  /** The tape reaches back past the window start (or holds every trade the source returned). */
  complete: boolean;
}

/**
 * Count trades with `from < t <= to` by side and sum their USD. The tape holds only the newest `cap`
 * trades, so a full tape whose oldest trade is younger than `from` under-counts: `complete` is false.
 */
export function tapeWindow(trades: readonly LiveTrade[], from: number, to: number, cap = TAPE_CAP): TapeWindow {
  let buys = 0, sells = 0, buyUsd = 0, sellUsd = 0;
  let oldest = Infinity;
  for (const tr of trades) {
    if (tr.t < oldest) oldest = tr.t;
    if (tr.t <= from || tr.t > to) continue;
    const usd = Number.isFinite(tr.usd) ? tr.usd : 0;
    if (tr.side === 'buy') { buys += 1; buyUsd += usd; } else { sells += 1; sellUsd += usd; }
  }
  const complete = trades.length < cap || oldest <= from;
  return { buys, sells, buyUsd, sellUsd, complete };
}

/**
 * The ring sample to compare against for a window of `ms`: the one closest to `latestT - ms` within
 * ±PREV_TOLERANCE·ms. When none qualifies, `waitMs` is how long until the next sample becomes old enough.
 */
export function prevSample(samples: readonly FlowSample[], latestT: number, ms: number): { sample: FlowSample } | { waitMs: number } {
  const target = latestT - ms;
  const tol = ms * PREV_TOLERANCE;
  let best: FlowSample | null = null;
  let bestD = Infinity;
  let youngestTooNew = -Infinity; // the oldest sample still younger than (1 - tol) * ms
  for (const s of samples) {
    const d = Math.abs(s.t - target);
    if (d <= tol && d < bestD) { best = s; bestD = d; }
    const age = latestT - s.t;
    if (age < ms - tol && age > youngestTooNew) youngestTooNew = age;
  }
  if (best) return { sample: best };
  const age = youngestTooNew === -Infinity ? 0 : youngestTooNew;
  return { waitMs: Math.max(1, ms - tol - age) };
}

/** Thin a ring (oldest first): keep the newest; older samples need spacing ≥ max(5 s, 2 % of their age). */
export function thinSamples(samples: readonly FlowSample[]): FlowSample[] {
  if (samples.length <= 1) return samples.slice();
  const latest = samples[samples.length - 1].t;
  const out: FlowSample[] = [samples[samples.length - 1]];
  let lastKept = latest;
  for (let i = samples.length - 2; i >= 0; i--) {
    const s = samples[i];
    const age = latest - s.t;
    if (age > MAX_AGE_MS) break;
    if (lastKept - s.t >= Math.max(MIN_SAMPLE_GAP_MS, age * THIN_FRACTION)) { out.push(s); lastKept = s.t; }
  }
  out.reverse();
  return out.length > MAX_SAMPLES ? out.slice(out.length - MAX_SAMPLES) : out;
}

export interface FlowTrackerOptions {
  /** Wall clock for the cache-read throttle (not for data times). */
  clock?: () => number;
  /** At most one cache read per mint per this many ms (the render loop can draw many frames a second). */
  minReadMs?: number;
  /** Mints kept (least-recently observed dropped first). */
  maxMints?: number;
}

/** Per-mint ring of DexScreener flow samples plus the row builder for the panel. In-memory only. */
export class FlowTracker {
  private readonly rings = new Map<string, FlowSample[]>();
  private readonly lastRead = new Map<string, number>();
  private readonly clock: () => number;
  private readonly minReadMs: number;
  private readonly maxMints: number;

  constructor(opts: FlowTrackerOptions = {}) {
    this.clock = opts.clock ?? (() => Date.now());
    this.minReadMs = opts.minReadMs ?? 1_000;
    this.maxMints = opts.maxMints ?? 24;
  }

  /** Add a DexScreener observation. Same-or-older `t` than the newest sample is ignored (cache re-reads). */
  observe(mint: string, s: FlowSample): void {
    const ring = this.rings.get(mint) ?? [];
    const last = ring[ring.length - 1];
    if (last && s.t <= last.t) return;
    ring.push(s);
    this.rings.delete(mint); // bump recency
    this.rings.set(mint, thinSamples(ring));
    while (this.rings.size > this.maxMints) {
      const oldest = this.rings.keys().next().value as string;
      this.rings.delete(oldest);
      this.lastRead.delete(oldest);
    }
  }

  samples(mint: string): readonly FlowSample[] {
    return this.rings.get(mint) ?? [];
  }

  /**
   * Pull the DexScreener pair `Store.enrich` cached for this mint (no network) into the ring. Throttled
   * per mint; a cache miss or a pair without txns is a no-op.
   */
  syncFromCache(cache: Pick<Cache, 'get'>, mint: string): void {
    const now = this.clock();
    const last = this.lastRead.get(mint);
    if (last !== undefined && now - last < this.minReadMs) return;
    this.lastRead.set(mint, now);
    let hit: { value: DsTokenView; fetchedAt: number } | undefined;
    try { hit = cache.get<DsTokenView>(DS_TOKEN_CACHE_NS, mint); } catch { return; }
    const pair = hit?.value?.pair;
    if (!hit || !pair || !pair.txns || !pair.volume) return;
    this.observe(mint, { t: pair.fetchedAt || hit.fetchedAt, txns: pair.txns, volume: pair.volume });
  }

  /**
   * The panel rows: 1m from the tape, then the DexScreener windows. `tape` is the token view's trades
   * and its panel status (the 1m window is anchored at the tape's fetch time, not the wall clock).
   */
  rows(mint: string, tape: { trades: readonly LiveTrade[]; panel: PanelStatus }, now: number): FlowPanelRow[] {
    const out: FlowPanelRow[] = [];
    const ring = this.samples(mint);
    const latest = ring[ring.length - 1] ?? null;
    for (const w of FLOW_WINDOWS) {
      if (w.ds === null) { out.push(tapeRow(w, tape, now)); continue; }
      if (!latest) { out.push({ label: w.label, buys: null, sells: null, buyUsd: null, sellUsd: null, volUsd: null, trend: { na: '—' }, note: 'no dexscreener pair yet' }); continue; }
      const cur = latest.txns[w.ds] ?? null;
      const prev = prevSample(ring, latest.t, w.ms);
      out.push({
        label: w.label,
        buys: cur ? cur.buys : null,
        sells: cur ? cur.sells : null,
        buyUsd: null,
        sellUsd: null,
        volUsd: latest.volume[w.ds] ?? null,
        trend: 'sample' in prev ? trendCell(cur, prev.sample.txns[w.ds] ?? null) : { wait: fmtWait(prev.waitMs) },
      });
    }
    return out;
  }

  /** `dexscreener 8s · 1m from tape` — the panel caption (age of the newest DexScreener sample). */
  caption(mint: string, now: number): string {
    const ring = this.samples(mint);
    const latest = ring[ring.length - 1];
    const ds = latest ? `dexscreener ${Math.max(0, Math.round((now - latest.t) / 1000))}s` : 'dexscreener —';
    return `${ds} · 1m from tape`;
  }
}

function tapeRow(w: FlowWindowDef, tape: { trades: readonly LiveTrade[]; panel: PanelStatus }, now: number): FlowPanelRow {
  const p = tape.panel;
  const empty = { label: w.label, buys: null, sells: null, buyUsd: null, sellUsd: null, volUsd: null, trend: { na: '—' } as FlowTrendCell };
  if (p.fetchedAt === null && (p.state === 'loading' || p.state === 'idle')) return { ...empty, note: 'loading tape…' };
  if (p.fetchedAt === null) return { ...empty, note: `tape unavailable${p.reason ? `: ${p.reason}` : ''}` };
  const anchor = p.fetchedAt ?? now;
  const cur = tapeWindow(tape.trades, anchor - w.ms, Infinity);
  const prev = tapeWindow(tape.trades, anchor - 2 * w.ms, anchor - w.ms);
  return {
    label: w.label,
    buys: cur.buys,
    sells: cur.sells,
    buyUsd: cur.complete ? cur.buyUsd : null,
    sellUsd: cur.complete ? cur.sellUsd : null,
    volUsd: cur.buyUsd + cur.sellUsd,
    partial: !cur.complete,
    // A full tape that does not reach back far enough cannot give the window (counts get a `+`) or the
    // previous minute honestly: say which, never compare against a truncated count.
    trend: !cur.complete ? { na: 'partial' } : !prev.complete ? { na: 'prev n/a' } : trendCell(cur, prev),
  };
}
