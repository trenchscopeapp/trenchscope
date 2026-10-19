// @dexterm/tui — trade-moment effects (task-1340, ported from prototype-v2/src/fx-trade.mjs, task-1291).
//
// A post-pass inside applyFx with the same rules as every other effect: a pure function of (canvas, vfx, frame)
// that writes only through putFx / tintFx, so hard cells (numbers, tickers, key hints) and SHIELDED cells (the
// whole trade ticket) are untouchable by construction. Two structural rules, not conventions:
//   1. `fireMoment` requires a SETTLED chain outcome (`status` confirmed | failed) and throws on anything else:
//      a quote, a plan or an in-flight send has no path to an effect. The outcome rides on the moment so a test
//      can assert what fired and why.
//   2. The only "pending" visual is `fireInflight`: a neutral cyan sweep that is never a verdict.
//
// Moments: buy (green shockwave + coins streaming up) · profit (gold burst, gold rain) · loss (red static that
// collapses; no shake, no mockery) · failed (red lockout flicker in the bands) · runner (gold burst, standalone).
// Tiers: off = nothing (results appear instantly) · normal · fever (longer, denser). Any key skips (skipMoment).
import type { Canvas, Rect } from './canvas.ts';
import { mix, type Hex } from './color.ts';
import { hash3, CODE, type Vfx } from './fx.ts';

const unit = (a: number, b: number, c: number): number => hash3(a, b, c) / 4294967296;
const COINS = '$◆●¢◇✦∘';
const BURST = '✦✧◆·∗⟡';
const STATIC = '░▒▓▒░';

export type MomentKind = 'inflight' | 'buy' | 'profit' | 'loss' | 'failed' | 'runner';
export type Milestone = 'first' | 'target' | 'stop' | 'rug' | null;

/** The settled on-chain (or paper-ledger) outcome a moment is fired from. Nothing else may fire one. */
export interface SettledTx {
  status: 'confirmed' | 'failed';
  side: 'buy' | 'sell';
  symbol: string;
  mint: string;
  /** Transaction signature when one exists (null for a paper fill or a refusal before signing). */
  sig: string | null;
  /** Signed SOL change (buy < 0, sell > 0), whole SOL; null when unknown. */
  solDelta: number | null;
  /** Realized PnL of a sell in SOL (0 on a buy), null when the ledger does not know. */
  pnlSol: number | null;
  /** Realized PnL as a fraction of cost (0.37 = +37 %). */
  pnlPct: number | null;
  /** 'paper' (simulated ledger) or 'live' (a real confirmed transaction). */
  ledger: 'paper' | 'live';
  /** Why a failed outcome failed (refusal / send error), for the result line. */
  reason?: string;
}

export interface TradeMoment {
  kind: MomentKind;
  milestone: Milestone;
  /** Frame the moment started at. */
  t0: number;
  /** Duration in frames (0 for inflight: it runs until skipped or replaced). */
  dur: number;
  /** Where the effect originates (the ticket / row rect); null = screen centre. */
  origin: Rect | null;
  symbol: string;
  pnl: number;
  pct: number;
  tx: SettledTx | null;
  seed: number;
}

/** Durations in seconds per kind; fever runs longer and denser. */
export const MOMENT_SECONDS: Record<Exclude<MomentKind, 'inflight'>, number> = { buy: 1.8, profit: 2.1, loss: 1.8, failed: 1.2, runner: 2.0 };

export function momentFrames(kind: MomentKind, intensity: Vfx['intensity'], fps: number): number {
  if (kind === 'inflight') return 0;
  const s = MOMENT_SECONDS[kind];
  const k = intensity === 'fever' ? 1.45 : 1;
  return Math.max(2, Math.round(s * k * fps));
}

/** Progress of the current moment in [0, 1], null when none (or finished). Inflight is always 0. */
export function momentP(v: Pick<Vfx, 'frame' | 'moment'>): number | null {
  const m = v.moment;
  if (!m) return null;
  if (m.kind === 'inflight') return 0;
  const p = (v.frame - m.t0) / Math.max(1, m.dur);
  return p > 1 ? null : p;
}

/** Classify a settled outcome: buy → 'buy'; sell → 'profit' | 'loss' by realized PnL; failed → 'failed'. */
export function momentKindFor(tx: SettledTx): Exclude<MomentKind, 'inflight' | 'runner'> {
  if (tx.status === 'failed') return 'failed';
  if (tx.side === 'buy') return 'buy';
  return (tx.pnlSol ?? 0) >= 0 ? 'profit' : 'loss';
}

export interface FireOptions {
  milestone?: Milestone;
  origin?: Rect | null;
  fps?: number;
}

/**
 * Fire the moment for a SETTLED outcome. Throws unless `tx.status` is confirmed or failed — the same guard the
 * prototype's settle() had — so a quote, a plan or an in-flight send cannot reach the effects. Returns the moment
 * (or null when effects are off). Side effects on the vfx: mood ramp swap and a glitch for loss / failed; the
 * shake is never used while a shielded ticket is on screen (shake() refuses shields anyway).
 */
export function fireMoment(v: Vfx, tx: SettledTx, opts: FireOptions = {}): TradeMoment | null {
  if (!tx || (tx.status !== 'confirmed' && tx.status !== 'failed')) throw new Error('fireMoment needs a settled chain outcome (confirmed | failed), not a quote');
  const kind = momentKindFor(tx);
  if (v.intensity === 'off') { v.moment = null; return null; }
  const fps = opts.fps ?? 30;
  const milestone = opts.milestone ?? null;
  const m: TradeMoment = {
    kind, milestone, t0: v.frame, dur: momentFrames(kind, v.intensity, fps), origin: opts.origin ?? null,
    symbol: tx.symbol, pnl: tx.pnlSol ?? 0, pct: tx.pnlPct ?? 0, tx, seed: hash3(v.seed, v.frame, 77),
  };
  if (milestone) m.dur = Math.round(m.dur * 1.35);
  v.moment = m;
  const fever = v.intensity === 'fever';
  if (kind === 'buy') { v.activity = Math.max(v.activity, fever ? 1 : 0.8); }
  else if (kind === 'profit') { v.mood = 'pump'; v.moodUntil = v.frame + Math.round(fps * (fever ? 4 : 3)); v.activity = 1; }
  else if (kind === 'loss') { v.mood = 'dump'; v.moodUntil = v.frame + Math.round(fps * 3); v.glitch = Math.max(v.glitch, fever ? 0.7 : 0.45); v.stutter = 0; }
  else if (kind === 'failed') { v.glitch = Math.max(v.glitch, 0.25); }
  if (milestone === 'rug') { v.glitch = 1; v.mood = 'dump'; v.moodUntil = v.frame + Math.round(fps * 4); }
  return m;
}

/** The pending state: a neutral scanning sweep while a send is in flight. Never a verdict; replaced by fireMoment. */
export function fireInflight(v: Vfx, symbol: string, origin: Rect | null = null): TradeMoment | null {
  if (v.intensity === 'off') { v.moment = null; return null; }
  const m: TradeMoment = { kind: 'inflight', milestone: null, t0: v.frame, dur: 0, origin, symbol, pnl: 0, pct: 0, tx: null, seed: hash3(v.seed, v.frame, 78) };
  v.moment = m;
  return m;
}

/** Called by stepVfx every frame: drops a finished moment and lets a mood swap expire. */
export function stepMoment(v: Vfx): void {
  if (v.moodUntil != null && v.frame >= v.moodUntil) { v.mood = 'neutral'; v.moodUntil = null; }
  if (v.moment && v.moment.kind !== 'inflight' && momentP(v) == null) v.moment = null;
}

/** Any key: the moment is dropped (the result card stays: it is content, not an effect). Inflight stays. */
export function skipMoment(v: Vfx): void {
  if (v.moment && v.moment.kind !== 'inflight') v.moment = null;
  if (v.moodUntil != null) { v.mood = 'neutral'; v.moodUntil = null; }
  v.glitch = 0; v.shake = 0; v.stutter = 0;
}

/** Clear the inflight sweep (the send settled or was cancelled). */
export function clearInflight(v: Vfx): void {
  if (v.moment?.kind === 'inflight') v.moment = null;
}

function center(o: Rect | null, c: Canvas): { cx: number; cy: number } {
  if (!o) return { cx: Math.floor(c.w / 2), cy: Math.floor(c.h / 2) };
  return { cx: o.x + Math.floor(o.w / 2), cy: o.y + Math.floor(o.h / 2) };
}

/** Theme-derived palettes: gold from the pump ramp, a green "buy" ramp from `up`. */
function palettes(c: Canvas): { gold: Hex; goldHot: Hex; buy: [Hex, Hex, Hex, Hex] } {
  const t = c.theme;
  return { gold: t.rainPump[2], goldHot: t.rainPump[3], buy: [mix(t.bg, t.up, 0.3), mix(t.bg, t.up, 0.6), t.up, mix(t.up, '#ffffff', 0.6)] };
}

/** The post-pass. No-op without a live moment or when effects are off. */
export function tradeFx(c: Canvas, v: Vfx): void {
  if (!v || v.intensity === 'off') return;
  const m = v.moment;
  if (!m) return;
  const p = momentP(v);
  if (p == null) return;
  const t = c.theme;
  const { gold, goldHot, buy: rainBuy } = palettes(c);
  const fever = v.intensity === 'fever';
  const f = v.frame;
  const W = c.w, H = c.h;
  const fps = 30;
  const { cx, cy } = center(m.origin, c);
  const dist = (x: number, y: number) => Math.sqrt((x - cx) * (x - cx) + (2 * (y - cy)) * (2 * (y - cy)));

  if (m.kind === 'inflight') {
    // scanning sweep: one bright row sweeping down every 0.7 s, bg tint on soft cells + a faint trail
    const per = Math.max(6, Math.round(0.7 * fps));
    const ys = Math.floor(((f - m.t0) % per) / per * H);
    for (let k = 0; k < 3; k++) {
      const y = ys - k;
      if (y < 0 || y >= H) continue;
      const amt = k === 0 ? 0.28 : k === 1 ? 0.14 : 0.06;
      for (let x = 0; x < W; x++) {
        c.tintFx(x, y, t.cyan, amt);
        if (k === 0 && c.zone[c.idx(x, y)] && unit(x, y, f) < 0.35) c.putFx(x, y, '╌', { fg: mix(t.bg, t.cyan, 0.7) });
      }
    }
    return;
  }

  if (m.kind === 'buy') {
    // shockwave ring from the origin, 0–0.6; inside the ring the bg lifts toward green and fades
    const R = Math.max(W, H * 2) * 0.75;
    const pr = Math.min(1, p / 0.6);
    const r = pr * R;
    const fade = 1 - pr;
    if (pr < 1) {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const d = dist(x, y);
        const dd = Math.abs(d - r);
        if (dd < 1.4) {
          if (c.zone[c.idx(x, y)]) c.putFx(x, y, dd < 0.6 ? '○' : '∘', { fg: mix(rainBuy[2], rainBuy[3], fade), b: dd < 0.6 });
          c.tintFx(x, y, t.up, (dd < 0.6 ? 0.3 : 0.2) * fade);
        } else if (d < r && d > r - 6) c.tintFx(x, y, t.up, 0.10 * fade * (1 - (r - d) / 6));
      }
    }
    // coins / glyphs streaming up from the origin row
    const N = (fever ? 90 : 46) * Math.max(1, Math.floor(W / 120));
    const ox = m.origin ? m.origin.x : 0, ow = m.origin ? m.origin.w : W, oy = m.origin ? m.origin.y : cy;
    for (let i = 0; i < N; i++) {
      const born = unit(m.seed, i, 1) * 0.55;
      const age = p - born;
      if (age < 0 || age > 0.55) continue;
      const x = ox + Math.floor(unit(m.seed, i, 2) * ow);
      const speed = (0.6 + unit(m.seed, i, 3) * 0.9) * H * 1.3;
      const y = Math.round(oy - age * speed);
      const wobble = Math.round(Math.sin((age * 9 + i) * 1.7) * 1);
      if (y < 0 || y >= H) continue;
      const sym = m.symbol || '';
      const ch = unit(m.seed, i, 4) < 0.35 && sym ? sym[i % sym.length] : COINS[hash3(m.seed, i, 5) % COINS.length];
      const life = 1 - age / 0.55;
      const fg = life > 0.7 ? rainBuy[3] : life > 0.35 ? rainBuy[2] : rainBuy[1];
      c.putFx(x + wobble, y, ch, { fg, b: life > 0.7 });
      if (fever && life > 0.5) c.putFx(x + wobble, y + 1, '·', { fg: rainBuy[1] });
    }
    return;
  }

  if (m.kind === 'profit' || m.kind === 'runner') {
    // gold burst: particles radiate from the centre, slow down, drift down a little
    const N = (fever ? 140 : 70) * Math.max(1, Math.floor(W / 120));
    const R = Math.max(W, H * 2) * 0.5;
    for (let i = 0; i < N; i++) {
      const born = unit(m.seed, i, 1) * 0.18;
      const age = p - born;
      if (age < 0 || age > 0.75) continue;
      const a = unit(m.seed, i, 2) * Math.PI * 2;
      const sp = 0.4 + unit(m.seed, i, 3) * 0.9;
      const d = (1 - Math.pow(1 - age / 0.75, 2)) * sp * R * 0.9;
      const x = Math.round(cx + Math.cos(a) * d);
      const y = Math.round(cy + Math.sin(a) * d * 0.5 + age * age * 6);
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      const life = 1 - age / 0.75;
      const ch = BURST[hash3(m.seed, i, 6 + (f >> 2)) % BURST.length];
      const fg = life > 0.75 ? goldHot : life > 0.4 ? gold : mix(t.bg, gold, 0.55);
      if (!c.putFx(x, y, ch, { fg, b: life > 0.75 })) c.tintFx(x, y, gold, 0.25 * life);
      if (fever) c.tintFx(x, y, gold, 0.12 * life);
    }
    if (p < 0.4) for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 10; x <= cx + 10; x++) c.tintFx(x, y, gold, 0.18 * (1 - p / 0.4) * (1 - Math.abs(x - cx) / 11));
    return;
  }

  if (m.kind === 'loss') {
    // red static that collapses: 0–0.35 density rises everywhere; 0.35–1 a line falls and clears the screen above it
    const dens = (fever ? 0.5 : 0.36) * Math.min(1, p / 0.35);
    const yl = p < 0.35 ? -1 : Math.floor((p - 0.35) / 0.55 * (H + 1));
    for (let y = 0; y < H; y++) {
      if (y < yl) continue;
      const rowDens = dens * (yl >= 0 ? Math.min(1, (y - yl) / 4 + 0.3) : 1);
      for (let x = 0; x < W; x++) {
        if (unit(x, y, f) >= rowDens) continue;
        const ch = unit(x, y, f + 9) < 0.7 ? STATIC[hash3(x, y, f) % STATIC.length] : CODE[hash3(x, y, f + 1) % CODE.length];
        const tier = unit(x, y, f + 3);
        const fg = tier < 0.1 ? t.rainDump[2] : tier < 0.5 ? t.rainDump[1] : t.rainDump[0];
        if (!c.putFx(x, y, ch, { fg })) c.tintFx(x, y, t.down, 0.08);
      }
      if (y === yl || y === yl + 1) for (let x = 0; x < W; x++) c.tintFx(x, y, t.down, y === yl ? 0.2 : 0.1);
    }
    return;
  }

  if (m.kind === 'failed') {
    // lockout flicker: header band + footer row tint red every other 4 frames for 0.8 s; sparse static near the bands
    const on = Math.floor((f - m.t0) / 4) % 2 === 0 && p < 0.7;
    if (on) for (let x = 0; x < W; x++) { c.tintFx(x, 1, t.down, 0.35); c.tintFx(x, 0, t.down, 0.18); c.tintFx(x, H - 1, t.down, 0.18); c.tintFx(x, H - 2, t.down, 0.12); }
    if (p < 0.5) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!c.zone[c.idx(x, y)] || unit(x, y, f) >= 0.06 * (1 - p / 0.5)) continue;
      c.putFx(x, y, STATIC[hash3(x, y, f) % STATIC.length], { fg: t.rainDump[1] });
    }
  }
}
