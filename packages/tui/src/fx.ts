// @dexterm/tui — the cyberspace effects engine (VISUAL-V2 §3), ported from prototype-v2/src/fx.mjs.
//
// Everything here is a pure function of (canvas, vfx state, frame index). The PRNG is a hash of
// (seed, x, y, frame) so a given frame index always produces the same cells: snapshots stay testable
// and the demo video is reproducible. Effects write through Canvas.putFx, which refuses hard cells
// (data glyphs) and, for rain, cells outside registered rain zones. Nothing here can overdraw a
// number, a ticker or a key hint.
//
// Passes (applied in this order by applyFx):
//   rain      matrix rain of katakana / hex / the user's own tickers / tx-hash fragments, in zones only
//   trails    bloom: last frames' rain cells linger dimmer (CRT phosphor persistence)
//   aberrate  chromatic aberration ghosts on headings (magenta left, cyan right) + per-glyph colour split
//   mosh      datamosh blocks: soft cells (borders, rain, backgrounds) shift sideways; bg tint on rows
//   shake     whole-frame 1-cell offset for big events (moves data, never covers it)
//   scan      CRT scanlines: odd rows' backgrounds pulled 7 % toward the scan colour
//
// Separate helpers: blinkFrame (screen transition), decrypt (streaming text), spinner, bootLogo,
// and the market → rain mapping (marketActivity / candleActivity).
import { Canvas, type Style } from './canvas.ts';
import { mix, type Hex } from './color.ts';
import type { Ramp } from './theme.ts';
import type { Candle } from '@dexterm/data';
import { tradeFx, stepMoment, type TradeMoment } from './fx-trade.ts';

export const KATAKANA = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ';
export const HEX = '0123456789ABCDEF';
/** Code glyphs for floods / decrypt: katakana + hex + a few symbols. */
export const CODE = KATAKANA + HEX + '∷⋮⋯╳◇◆';
/** The same set without katakana, for C/POSIX locales or terminals that draw half-width kana two cells wide. */
export const CODE_ASCII = HEX + '∷⋮⋯╳◇◆';
/** Claude Code spinner family. */
export const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽'];

/** 32-bit integer hash of up to three ints; stable across platforms. */
export function hash3(a: number, b = 0, c = 0): number {
  let h = (a | 0) * 0x9e3779b1 ^ (b | 0) * 0x85ebca77 ^ (c | 0) * 0xc2b2ae3d;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}
const unit = (a: number, b: number, c: number): number => hash3(a, b, c) / 4294967296;

export type Mood = 'neutral' | 'pump' | 'dump';
export type Intensity = 'off' | 'normal' | 'fever';
export type PulseKind = 'newpair' | 'rug' | 'pump' | 'dump';
export type ToastLevel = 'up' | 'down' | 'warn' | 'ai' | 'info';

export interface Toast { text: string; level: ToastLevel; until: number }

export interface Vfx {
  seed: number;
  frame: number;
  /** off = calm: no rain, trails, aberration, mosh, shake, blink or scanlines. */
  intensity: Intensity;
  /** 0..1, drives rain density + speed (market activity). */
  activity: number;
  /** Rain palette. */
  mood: Mood;
  /** 0..1, decays ×0.82 per frame; set by events (new pair, rug flag). */
  glitch: number;
  /** Frames of screen shake left. */
  shake: number;
  /** Frames to hold the previous frame (datamosh stutter). */
  stutter: number;
  /** Cell index → lingering rain cell. */
  trail: Map<number, { ch: string; fg: Hex; age: number }>;
  /** Strings that fall as rain columns (the user's own tickers, mints, tx tails). */
  sources: string[];
  /** Idle aberration intensity on headings. */
  baseline: number;
  /** Glyph set for rain / floods. */
  code: string;
  toast: Toast | null;
  /** task-1340: the live trade moment (effects after a CONFIRMED on-chain result), or null. */
  moment?: TradeMoment | null;
  /** Frame until which a moment's mood swap (buy/pump/dump rain) holds; null = none. */
  moodUntil?: number | null;
}

export interface VfxOpts {
  seed?: number;
  intensity?: Intensity;
  /** Shortcut for intensity 'off'. */
  calm?: boolean;
  sources?: string[];
  /** Use the hex-only glyph set (no katakana). */
  ascii?: boolean;
}

export function makeVfx(opts: VfxOpts = {}): Vfx {
  const intensity: Intensity = opts.calm ? 'off' : (opts.intensity ?? 'off');
  return {
    seed: opts.seed ?? 7,
    frame: 0,
    intensity,
    activity: 0.5,
    mood: 'neutral',
    glitch: 0,
    shake: 0,
    stutter: 0,
    trail: new Map(),
    sources: opts.sources ? sourcesWithCode(opts.sources, opts.ascii ? CODE_ASCII : CODE) : [],
    baseline: intensity === 'fever' ? 0.12 : 0,
    code: opts.ascii ? CODE_ASCII : CODE,
    toast: null,
  };
}

export function isCalm(v: Vfx): boolean { return v.intensity === 'off'; }

/** Rain columns are the user's own data (tickers, mint prefixes, tx tails) plus katakana and hex runs. */
export function setSources(v: Vfx, strings: string[]): void {
  v.sources = sourcesWithCode(strings, v.code);
}

function sourcesWithCode(strings: string[], code: string): string[] {
  const s = strings.filter((x) => x && x.length >= 2).slice(0, 80);
  const kana = code === CODE ? KATAKANA : HEX;
  for (let i = 0; i < 12; i++) s.push(Array.from({ length: 8 + i % 5 }, (_, k) => kana[(i * 7 + k * 13) % kana.length]).join(''));
  for (let i = 0; i < 6; i++) s.push(Array.from({ length: 10 }, (_, k) => HEX[(i * 5 + k * 3) % 16]).join(''));
  return s;
}

/** Event hooks. Glitch decays per frame; mood sticks until the market data says otherwise. */
export function pulse(v: Vfx, kind: PulseKind): void {
  if (isCalm(v)) return;
  const k = v.intensity === 'fever' ? 1 : 0.6;
  if (kind === 'newpair') { v.glitch = Math.max(v.glitch, 0.8 * k); v.shake = v.intensity === 'fever' ? 2 : 1; v.stutter = v.intensity === 'fever' ? 2 : 1; }
  else if (kind === 'rug') { v.glitch = 1 * k; v.shake = v.intensity === 'fever' ? 3 : 2; v.stutter = v.intensity === 'fever' ? 3 : 1; v.mood = 'dump'; }
  else if (kind === 'pump') { v.mood = 'pump'; v.activity = 1; v.shake = 1; }
  else if (kind === 'dump') { v.mood = 'dump'; v.activity = 1; v.shake = 1; }
}

export function stepVfx(v: Vfx): void {
  v.frame += 1;
  v.glitch = v.glitch > 0.02 ? v.glitch * 0.82 : 0;
  if (v.shake > 0) v.shake -= 1;
  if (v.stutter > 0) v.stutter -= 1;
  stepMoment(v);
}

/**
 * True when a per-event animation is live and needs full-rate redraws (task-1303): a glitch/mosh is
 * decaying, or the frame is shaking or held (datamosh). Ambient rain and its phosphor trails are NOT
 * counted — they animate forever, so between events the loop throttles them down to the idle rate to
 * keep CPU low while keeping the look. (High market `activity` keeps the loop at full rate via the
 * caller, so a fast-moving market still rains smoothly.)
 */
export function fxBusy(v: Vfx): boolean {
  return v.glitch > 0.02 || v.shake > 0 || v.stutter > 0 || !!v.moment;
}

// ---------------------------------------------------------------- market → rain

export interface Activity { activity: number; mood: Mood }

/**
 * Activity from a market cross-section: 5-minute price deltas (percent) and, when known, volume
 * velocities (5 m volume scaled to 24 h over the 24 h volume; 1 = steady). Mean |Δ5m| / 6 maps 0..1
 * (fixture noise ≈ 2 % → 0.33); velocity above 1 raises it. Net bias beyond ±3 % sets the mood.
 */
export function marketActivity(deltas: ReadonlyArray<number | null | undefined>, velocities: ReadonlyArray<number | null | undefined> = []): Activity {
  let sum = 0, net = 0, n = 0;
  for (const d of deltas) { if (d == null || !Number.isFinite(d)) continue; sum += Math.abs(d); net += d; n += 1; }
  const mean = n ? sum / n : 0;
  let act = mean / 6;
  let vsum = 0, vn = 0;
  for (const v of velocities) { if (v == null || !Number.isFinite(v)) continue; vsum += Math.max(0, Math.min(3, v)); vn += 1; }
  if (vn) act = 0.5 * act + 0.5 * ((vsum / vn - 0.5) / 2.5);
  const activity = n || vn ? Math.max(0.15, Math.min(1, act)) : 0.5;
  const bias = n ? net / n : 0;
  return { activity, mood: bias > 3 ? 'pump' : bias < -3 ? 'dump' : 'neutral' };
}

/**
 * Activity for a token screen: the selected token's own candles. The last three candles' net move
 * beyond ±6 % (or a 5 m move beyond ±5 %) sets the mood; their absolute moves and the last candle's
 * volume against the previous dozen set the activity.
 */
export function candleActivity(candles: ReadonlyArray<Candle>, m5: number | null | undefined = null): Activity {
  const n = candles.length;
  if (n < 2) return { activity: 0.5, mood: 'neutral' };
  const k = Math.min(3, n - 1);
  const base = candles[n - 1 - k].c || candles[n - 1 - k].o || 1;
  const net = (candles[n - 1].c / base - 1) * 100;
  let moves = 0;
  for (let i = n - k; i < n; i++) { const o = candles[i].o || 1; moves += Math.abs(candles[i].c / o - 1) * 100; }
  const prev = candles.slice(Math.max(0, n - 13), n - 1);
  const vmean = prev.length ? prev.reduce((s, c) => s + c.v, 0) / prev.length : candles[n - 1].v;
  const vratio = vmean > 0 ? candles[n - 1].v / vmean : 1;
  const act = Math.max(0.15, Math.min(1, 0.6 * (moves / 12) + 0.4 * Math.min(1, vratio / 2.5)));
  const m = m5 ?? 0;
  const mood: Mood = net > 6 || m > 5 ? 'pump' : net < -6 || m < -5 ? 'dump' : 'neutral';
  return { activity: act, mood };
}

/** EMA step for activity (0.7 old + 0.3 new per data tick). */
export function blendActivity(v: Vfx, act: Activity, setMood = true): void {
  v.activity = v.activity * 0.7 + act.activity * 0.3;
  if (setMood) v.mood = act.mood;
}

// ---------------------------------------------------------------- rain

function rainPalette(c: Canvas, v: Vfx): Ramp {
  const t = c.theme;
  return v.mood === 'pump' ? t.rainPump : v.mood === 'dump' ? t.rainDump : t.rain;
}

export function rain(c: Canvas, v: Vfx): void {
  const t = c.theme;
  const pal = rainPalette(c, v);
  const f = v.frame;
  const W = c.w, H = c.h;
  const scale = v.intensity === 'fever' ? 1 : 0.6;
  const density = (0.4 + 0.55 * v.activity) * scale;      // share of columns carrying a drop
  const speedBase = 0.18 + 0.5 * v.activity;              // rows per frame (30 fps → 5..20 rows/s)
  const dimPanel = (col: Hex) => mix(t.panel, col, 0.8);
  const code = t.mono ? CODE_ASCII : v.code;
  for (let x = 0; x < W; x++) {
    // Each column has an independent drop; its parameters re-roll every cycle so columns do not sync.
    const colSeed = hash3(v.seed, x, 1);
    const speed = speedBase * (0.6 + 0.8 * unit(colSeed, 2, 0));
    const len = 5 + Math.floor(unit(colSeed, 3, 0) * 18);
    const period = H + len + 6 + Math.floor(unit(colSeed, 4, 0) * 20);
    const pos = (f * speed + unit(colSeed, 5, 0) * period);
    const cycle = Math.floor(pos / period);
    if (unit(colSeed, 6 + cycle, 0) > density) continue;    // this cycle the column is quiet
    const head = Math.floor(pos % period) - 2;
    const src = v.sources.length ? v.sources[hash3(colSeed, cycle, 9) % v.sources.length] : KATAKANA;
    const phase = hash3(colSeed, cycle, 10) % src.length;
    for (let k = 0; k < len; k++) {
      const y = head - k;
      if (y < 0 || y >= H) continue;
      const i = c.idx(x, y);
      if (!c.zone[i] || c.hard[i] || c.ch[i] !== ' ') continue;
      // glyph: source text reads downward; a few cells mutate each frame
      let ch = src[(y + phase) % src.length];
      if (unit(x, y, f) < 0.04) ch = code[hash3(x, y, f) % code.length];
      const tier = k === 0 ? 3 : k < 3 ? 2 : k < len * 0.6 ? 1 : 0;
      let fg = pal[tier];
      if (c.zone[i] === 2) fg = tier === 3 ? mix(pal[3], pal[2], 0.5) : dimPanel(pal[tier]);   // panel interiors stay quieter than bands
      c.putFx(x, y, ch, { fg, b: tier === 3 });
      v.trail.set(i, { ch, fg, age: 0 });
    }
  }
}

/** Phosphor persistence: cells drawn in the last few frames linger, dimmer each frame. */
export function trails(c: Canvas, v: Vfx): void {
  for (const [i, tr] of v.trail) {
    tr.age += 1;
    if (tr.age > 3) { v.trail.delete(i); continue; }
    if (i >= c.ch.length) { v.trail.delete(i); continue; }
    if (c.ch[i] !== ' ' || c.hard[i] || !c.zone[i]) continue;
    const bg = c.bg[i];
    const fg = mix(bg, tr.fg, tr.age === 1 ? 0.5 : tr.age === 2 ? 0.28 : 0.14);
    c.putFx(i % c.w, Math.floor(i / c.w), tr.ch, { fg });
  }
}

// ---------------------------------------------------------------- glitch

export function aberrate(c: Canvas, v: Vfx): void {
  const t = c.theme;
  const g = Math.max(v.baseline, v.glitch);
  if (g <= 0) return;
  const f = v.frame;
  for (const h of c.headings) {
    const i0 = c.idx(h.x, h.y);
    const str: string[] = [];
    for (let k = 0; k < h.w; k++) str.push(c.ch[i0 + k]);
    const first = str.findIndex((ch) => ch !== ' ');
    const last = str.length - 1 - [...str].reverse().findIndex((ch) => ch !== ' ');
    // ghost echoes only while an event glitch is live (idle headings just get the occasional colour split)
    if (first >= 0 && v.glitch > 0.25 && unit(f, h.x, h.y) < g) {
      const bgL = c.bg[c.idx(h.x + first - 1, h.y)] || t.bg;
      c.putFx(h.x + first - 1, h.y, str[first], { fg: mix(bgL, t.magenta, 0.75 * Math.min(1, 0.6 + g)) });
      const bgR = c.bg[c.idx(h.x + last + 1, h.y)] || t.bg;
      c.putFx(h.x + last + 1, h.y, str[last], { fg: mix(bgR, t.cyan, 0.75 * Math.min(1, 0.6 + g)) });
    }
    // per-glyph colour split: a few glyphs take the magenta / cyan fringe (glyph itself untouched)
    for (let k = 0; k < h.w; k++) {
      const i = i0 + k;
      if (c.ch[i] === ' ' || c.shield[i]) continue;
      const r = unit(f >> 1, h.x + k, h.y + 7);
      if (r < g * 0.45) c.fg[i] = (k & 1) ? t.magenta : t.cyan;
    }
  }
}

/** Datamosh: rectangular blocks whose soft cells (borders, rain, blanks) slide sideways; bg of alternate rows tinted. */
export function mosh(c: Canvas, v: Vfx): void {
  if (v.glitch <= 0.05) return;
  const t = c.theme;
  const f = v.frame;
  const n = Math.round(v.glitch * 7);
  for (let b = 0; b < n; b++) {
    const bw = 8 + Math.floor(unit(f, b, 1) * 40);
    const bh = 1 + Math.floor(unit(f, b, 2) * 4);
    const bx = Math.floor(unit(f, b, 3) * Math.max(1, c.w - bw));
    const by = Math.floor(unit(f, b, 4) * Math.max(1, c.h - bh));
    const k = (unit(f, b, 5) < 0.5 ? -1 : 1) * (1 + Math.floor(unit(f, b, 6) * 3));
    const tint = (b & 1) ? t.magenta : t.cyan;
    for (let y = by; y < Math.min(c.h, by + bh); y++) {
      const row: Array<[string, Hex, Hex, number]> = [];
      for (let x = bx; x < bx + bw; x++) { const i = c.idx(x, y); row.push([c.ch[i], c.fg[i], c.bg[i], c.hard[i]]); }
      for (let x = bx; x < bx + bw; x++) {
        if (x >= c.w) break;
        const i = c.idx(x, y);
        if (c.hard[i] || c.shield[i]) continue;
        const sx = x - k;
        if (sx < bx || sx >= bx + bw || sx >= c.w) continue;
        const [sch, sfg, sbg, shard] = row[sx - bx];
        if (shard || c.shield[c.idx(sx, y)]) continue;
        c.ch[i] = sch; c.fg[i] = sfg; c.bg[i] = sbg;
      }
      if ((y - by) % 2 === 0) for (let x = bx; x < Math.min(c.w, bx + bw); x++) { const i = c.idx(x, y); if (!c.shield[i]) c.bg[i] = mix(c.bg[i], tint, 0.12 * v.glitch); }
    }
  }
}

/** Whole-frame offset: data moves with the frame, nothing covers it. Vacated cells take the theme bg. */
export function shake(c: Canvas, v: Vfx): void {
  if (v.shake <= 0) return;
  if (c.hasShield) return; // task-1340: a shielded ticket never moves, so nothing moves
  const t = c.theme;
  const dx = ((v.frame & 1) ? 1 : -1) * (v.shake >= 3 ? 2 : 1);
  const dy = v.shake >= 2 && (v.frame % 3 === 0) ? 1 : 0;
  const ch = c.ch.slice(), fg = c.fg.slice(), bg = c.bg.slice(), at = c.at.slice(), hard = c.hard.slice();
  for (let y = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++) {
      const sx = x - dx, sy = y - dy;
      const i = c.idx(x, y);
      if (sx < 0 || sx >= c.w || sy < 0 || sy >= c.h) { c.ch[i] = ' '; c.fg[i] = t.text; c.bg[i] = t.bg; c.at[i] = 0; c.hard[i] = 0; continue; }
      const j = c.idx(sx, sy);
      c.ch[i] = ch[j]; c.fg[i] = fg[j]; c.bg[i] = bg[j]; c.at[i] = at[j]; c.hard[i] = hard[j];
    }
  }
}

/** CRT scanlines: odd rows pulled slightly toward the scan colour. Uniform, so contrast ratios barely move. */
export function scanlines(c: Canvas, amount = 0.07): void {
  const t = c.theme;
  for (let y = 1; y < c.h; y += 2) {
    const base = c.idx(0, y);
    for (let x = 0; x < c.w; x++) if (!c.shield[base + x]) c.bg[base + x] = mix(c.bg[base + x], t.scan, amount);
  }
}

export interface FxOpts {
  rain?: boolean;
  scan?: boolean;
}

/** Full post-pass. Order matters (see header comment). A no-op when the intensity is off. */
export function applyFx(c: Canvas, v: Vfx, opts: FxOpts = {}): Canvas {
  if (isCalm(v)) return c;
  if (opts.rain !== false) { rain(c, v); trails(c, v); }
  aberrate(c, v);
  mosh(c, v);
  shake(c, v);
  tradeFx(c, v); // task-1340: trade-moment post-pass (same putFx/tintFx rules; a no-op without a live moment)
  if (opts.scan !== false) scanlines(c);
  return c;
}

// ---------------------------------------------------------------- blink transition

/**
 * t in [0,1]. Phases: 0–0.28 eyelids close · 0.28–0.40 black beat · 0.40–0.62 code flood · 0.62–1 decrypt.
 * Returns a fresh Canvas. `from` may be null (boot). Any keypress in the interactive loop skips to t = 1.
 */
export function blinkFrame(from: Canvas | null, to: Canvas, t: number, v: Vfx): Canvas {
  const th = to.theme;
  const out = new Canvas(to.w, to.h, th);
  const W = to.w, H = to.h;
  const f = v.frame;
  const pal = th.rain;
  const code = th.mono ? CODE_ASCII : v.code;
  const lidStyle: Style = { fg: th.borderFocus, bg: '#000000', soft: true };
  const black: Style = { fg: th.text, bg: '#000000', soft: true };
  if (t < 0.28) {
    if (from && from.w === W && from.h === H) out.copyFrom(from); else out.fill(0, 0, W, H, ' ', black);
    const p = t / 0.28;
    const half = Math.ceil(H / 2);
    const cover = Math.floor(p * half);
    for (let y = 0; y < cover; y++) out.fill(0, y, W, 1, ' ', black);
    for (let y = H - cover; y < H; y++) out.fill(0, y, W, 1, ' ', black);
    if (cover > 0 && cover < half) { out.fill(0, cover, W, 1, '▀', lidStyle); out.fill(0, H - cover - 1, W, 1, '▄', lidStyle); }
    return out;
  }
  if (t < 0.40) { out.fill(0, 0, W, H, ' ', black); return out; }
  if (t < 0.62) {
    out.fill(0, 0, W, H, ' ', black);
    const p = (t - 0.40) / 0.22;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const r = unit(v.seed, x * 131 + y, 77);
      if (r > 0.25 + 0.65 * p) continue;
      const ch = code[hash3(x, y, f) % code.length];
      const tier = unit(x, y, f + 3) < 0.06 ? 3 : unit(x, y, f + 5) < 0.3 ? 2 : 1;
      out.put(x, y, ch, { fg: pal[tier], bg: '#000000', soft: true });
    }
    return out;
  }
  // decrypt: every cell resolves at its own time; unresolved cells show code glyphs
  out.copyFrom(to);
  const p = (t - 0.62) / 0.38;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const r = unit(v.seed, x * 131 + y, 99);
    if (r <= p) continue;
    const i = out.idx(x, y);
    const near = r - p < 0.12;
    out.ch[i] = code[hash3(x, y, f) % code.length];
    out.fg[i] = near ? pal[3] : pal[1 + (hash3(x, y, 5) % 2)];
    out.bg[i] = mix(out.bg[i], '#000000', 0.5 * (1 - p));
    out.at[i] = near ? 1 : 0;
    out.hard[i] = 0;
  }
  return out;
}

/** Number of blink frames at a given fps so the whole transition stays ≤ 350 ms (never fewer than 4). */
export function blinkFrames(fps = 30): number { return Math.max(4, Math.min(Math.floor(0.35 * fps), 11)); }

// ---------------------------------------------------------------- decrypt text + spinner

export interface DecryptCell { ch: string; kind: 'text' | 'code' | 'blank' }

/**
 * Streams `str` in: chars before `revealed` are plain, the next `window` non-space chars scramble
 * through code glyphs, the rest are blank.
 */
export function decrypt(str: string, revealed: number, frame: number, window = 6, code = CODE): DecryptCell[] {
  const out: DecryptCell[] = [];
  for (let k = 0; k < str.length; k++) {
    if (k < revealed) out.push({ ch: str[k], kind: 'text' });
    else if (k < revealed + window && str[k] !== ' ') out.push({ ch: code[hash3(k, frame, 11) % code.length], kind: 'code' });
    else if (k < revealed + window) out.push({ ch: ' ', kind: 'text' });
    else out.push({ ch: ' ', kind: 'blank' });
  }
  return out;
}

export function spinnerGlyph(frame: number): string { return SPINNER[Math.floor(frame / 3) % SPINNER.length]; }

/** Draw a decrypting line of text; returns x after the last revealed/coded glyph. */
export function decryptText(c: Canvas, x: number, y: number, str: string, revealed: number, frame: number, st: Style, maxW = Infinity, code = CODE): number {
  const t = c.theme;
  // the black-and-white look decrypts in hex and line glyphs, never katakana
  if (t.mono && code === CODE) code = CODE_ASCII;
  const cells = decrypt(str, revealed, frame, 6, code);
  const lim = Math.min(cells.length, maxW);
  for (let k = 0; k < lim; k++) {
    const cell = cells[k];
    if (cell.kind === 'blank') break;
    if (cell.kind === 'code') c.put(x + k, y, cell.ch, { fg: t.rain[2], bg: st.bg, soft: true });
    else c.put(x + k, y, cell.ch, st);
  }
  return x + lim;
}

// ---------------------------------------------------------------- boot logo

/** 5-row block font for the letters used by the logo. */
const FONT: Record<string, string[]> = {
  D: ['████ ', '█   █', '█   █', '█   █', '████ '],
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
  X: ['█   █', ' █ █ ', '  █  ', ' █ █ ', '█   █'],
  T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
  R: ['████ ', '█   █', '████ ', '█  █ ', '█   █'],
  M: ['█   █', '██ ██', '█ █ █', '█   █', '█   █'],
  N: ['█   █', '██  █', '█ █ █', '█  ██', '█   █'],
  C: [' ████', '█    ', '█    ', '█    ', ' ████'],
  H: ['█   █', '█   █', '█████', '█   █', '█   █'],
  S: [' ████', '█    ', ' ███ ', '    █', '████ '],
  O: [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
  P: ['████ ', '█   █', '████ ', '█    ', '█    '],
  ' ': ['  ', '  ', '  ', '  ', '  '],
};

export function logoRows(word = 'TRENCHSCOPE'): string[] {
  const rows = ['', '', '', '', ''];
  for (const ch of word) {
    const g = FONT[ch] || FONT[' '];
    for (let r = 0; r < 5; r++) rows[r] += g[r] + ' ';
  }
  return rows.map((r) => r.replace(/\s+$/, ''));
}

/** Big glitching logo. `intensity` 0..1 controls row jitter + colour split; returns the rect it occupies. */
export function bootLogo(c: Canvas, cx: number, cy: number, v: Pick<Vfx, 'frame'>, intensity = 0.3, word = 'TRENCHSCOPE'): Rect {
  const t = c.theme;
  const rows = logoRows(word);
  const w = Math.max(...rows.map((r) => r.length));
  const x0 = Math.floor(cx - w / 2);
  const f = v.frame;
  rows.forEach((row, r) => {
    const jitter = unit(f, r, 21) < intensity ? (unit(f, r, 22) < 0.5 ? -1 : 1) * (1 + Math.floor(unit(f, r, 23) * 2)) : 0;
    const color = t.logo[r % t.logo.length];
    for (let k = 0; k < row.length; k++) {
      if (row[k] === ' ') continue;
      const x = x0 + k + jitter, y = cy + r;
      const split = unit(f >> 1, k, r) < intensity * 0.5;
      const fg = split ? ((k & 1) ? t.magenta : t.cyan) : color;
      // ghost fringe one cell either side when intensity is high
      if (intensity > 0.5) {
        c.putFx(x - 1, y, '▌', { fg: mix(t.bg, t.magenta, 0.6) });
        c.putFx(x + 1, y, '▐', { fg: mix(t.bg, t.cyan, 0.6) });
      }
      c.put(x, y, '█', { fg, bg: t.bg, soft: true });
    }
  });
  return { x: x0, y: cy, w, h: 5 };
}

interface Rect { x: number; y: number; w: number; h: number }
