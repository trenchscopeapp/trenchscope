// @dexterm/tui — widgets drawn onto a Canvas (SPEC §7.3, VISUAL-V2 §3 "viz"): neon gradient
// sparkline, area sparkline with halo, glowing candles, gradient bars, badges, heat cells with ▲/▼,
// priority-dropping table, stat grid, key hints, trade tape rain.
// Every glyph is single-column. Numbers are always drawn with the theme's `text` colour on the local
// background (hard cells); glow is only ever applied to neighbouring blank cells or to bg tints.
import { Canvas, type Style } from './canvas.ts';
import { mix, luminance, type Hex } from './color.ts';
import { fmtUsd, fmtPct, fmtNum, fmtPrice, fmtAgeSec, shortAddr, clamp } from './fmt.ts';
import { launchpadColor } from './theme.ts';
import type { Candle, CandleInterval, Launchpad } from '@dexterm/data';

export const BLOCKS = '▁▂▃▄▅▆▇█';
// braille dot bits: column 0 rows 0..3, column 1 rows 0..3 (row 0 = top)
const BR_L = [0x01, 0x02, 0x04, 0x40];
const BR_R = [0x08, 0x10, 0x20, 0x80];

export function resample(values: readonly number[], w: number): number[] {
  if (values.length === w) return values.slice();
  const out: number[] = [];
  for (let i = 0; i < w; i++) {
    const p = (i / Math.max(1, w - 1)) * (values.length - 1);
    const a = Math.floor(p), b = Math.min(values.length - 1, a + 1);
    out.push(values[a] + (values[b] - values[a]) * (p - a));
  }
  return out;
}

/** Neon gradient: dim at the left, saturated in the middle, 45 % toward white at the recent end. */
export function neon(color: Hex, u: number, bg: Hex): Hex {
  if (u < 0.6) return mix(mix(bg, color, 0.65), color, u / 0.6);
  return mix(color, '#ffffff', (u - 0.6) / 0.4 * 0.45);
}

export interface SparkOpts {
  color?: Hex;
  bg?: Hex;
}

/** One-row sparkline. Block levels, neon gradient along time, hot last point. */
export function sparkline(c: Canvas, x: number, y: number, w: number, values: readonly number[] | undefined, opts: SparkOpts = {}): void {
  const t = c.theme;
  if (!values || values.length < 2 || w < 2) return;
  if (t.flat) { brailleLine(c, x, y, w, 1, values, opts); return; }
  const v = resample(values, w);
  const lo = Math.min(...v), hi = Math.max(...v);
  const range = hi - lo || 1;
  const up = v[v.length - 1] >= v[0];
  const color = opts.color || (up ? t.sparkUp : t.sparkDown);
  const bg = opts.bg || t.panel;
  for (let i = 0; i < w; i++) {
    const lvl = Math.round(((v[i] - lo) / range) * 7);
    const u = i / (w - 1);
    c.put(x + i, y, BLOCKS[clamp(lvl, 0, 7)], { fg: neon(color, u, bg), bg, soft: true });
  }
}

/**
 * Multi-row area sparkline: block glyphs, eighth-row precision, hot edge on top, gradient fill below,
 * and a braille glow halo in the row above the edge. Reads as a solid neon mountain on a dark scope.
 */
export function sparkArea(c: Canvas, x: number, y: number, w: number, h: number, values: readonly number[] | undefined, opts: SparkOpts = {}): void {
  const t = c.theme;
  if (!values || values.length < 2 || w < 2 || h < 1) return;
  const v = resample(values, w);
  const lo = Math.min(...v), hi = Math.max(...v);
  const range = hi - lo || 1;
  const up = v[v.length - 1] >= v[0];
  const color = opts.color || (up ? t.sparkUp : t.sparkDown);
  const bg = opts.bg || t.panel;
  for (let i = 0; i < w; i++) {
    const u = i / (w - 1);
    const units = ((v[i] - lo) / range) * (h * 8 - 1) + 1; // eighths, min 1
    const edgeRow = h - 1 - Math.floor((units - 1) / 8);
    for (let r = 0; r < h; r++) {
      const rowFromBottom = h - 1 - r;
      const rem = units - rowFromBottom * 8;
      if (rem <= 0) {
        if (r === edgeRow - 1) c.put(x + i, y + r, '⣀', { fg: mix(bg, color, 0.3), bg, soft: true }); // halo
        continue;
      }
      const lvl = clamp(Math.round(rem), 1, 8);
      const isEdge = r === edgeRow;
      const depth = (r - edgeRow) / Math.max(1, h - edgeRow);
      const fg = isEdge ? neon(color, u, bg) : mix(bg, color, 0.55 - depth * 0.3);
      c.put(x + i, y + r, BLOCKS[lvl - 1], { fg, bg, soft: true });
    }
  }
}

/** Braille line chart (2 samples per column, 4 levels per row): a thin neon trace. */
export function brailleLine(c: Canvas, x: number, y: number, w: number, h: number, values: readonly number[] | undefined, opts: SparkOpts = {}): void {
  const t = c.theme;
  if (!values || values.length < 2 || w < 2 || h < 1) return;
  const v = resample(values, w * 2);
  const lo = Math.min(...v), hi = Math.max(...v);
  const range = hi - lo || 1;
  const up = v[v.length - 1] >= v[0];
  const color = opts.color || (up ? t.sparkUp : t.sparkDown);
  const bg = opts.bg || t.panel;
  const rows = h * 4;
  const cells = new Array<number>(w * h).fill(0);
  let prev: number | null = null;
  for (let s = 0; s < w * 2; s++) {
    const r = Math.round((1 - (v[s] - lo) / range) * (rows - 1));
    const a = Math.min(prev ?? r, r), b = Math.max(prev ?? r, r);
    for (let rr = a; rr <= b; rr++) cells[Math.floor(rr / 4) * w + Math.floor(s / 2)] |= (s % 2 === 0 ? BR_L : BR_R)[rr % 4];
    prev = r;
  }
  for (let col = 0; col < w; col++) for (let r = 0; r < h; r++) {
    const bits = cells[r * w + col];
    if (bits) c.put(x + col, y + r, String.fromCharCode(0x2800 + bits), { fg: t.flat ? color : neon(color, col / (w - 1), bg), bg, soft: true });
  }
}

export interface CandleOpts {
  bg?: Hex;
  /** Draw the 3-row volume strip (default true). */
  volume?: boolean;
  interval?: CandleInterval | string;
  /**
   * task-1366: the axis labels read price × this (the market-cap view: price × the CURRENT supply ratio). The bars
   * are drawn from the prices, so the chart is glyph-for-glyph identical; volume is untouched.
   */
  scale?: number;
  /** task-1366: the right-hand axis / last-value formatter (default: the price formatter). */
  axisFmt?: (n: number) => string;
}

function fmtPriceAxis(p: number): string {
  if (p >= 1000) return p.toFixed(0);
  if (p >= 1) return p.toFixed(3);
  if (p >= 0.001) return p.toFixed(5);
  return p.toExponential(2);
}

/**
 * Candlestick chart with right-hand price axis, last-price tag, volume strip and time axis.
 * 3-column bodies with a centered wick, half-block tops/bottoms, ━ for dojis. Newest at right.
 * Bodies brighten with recency, glow ▐ into the gap column, and tint the row above/below 12 %.
 */
export function candleChart(c: Canvas, x: number, y: number, w: number, h: number, candles: readonly Candle[], opts: CandleOpts = {}): void {
  const t = c.theme;
  const bg = opts.bg || t.panel;
  const axisW = 10;
  const volH = opts.volume === false ? 0 : 3;
  const timeH = 1;
  const plotW = w - axisW;
  const plotH = h - volH - timeH;
  if (plotW < 10 || plotH < 4 || candles.length === 0) return;
  const CW = 4; // 3-col body with centered wick + 1-col gap
  const n = Math.min(candles.length, Math.floor(plotW / CW));
  const data = candles.slice(-n);
  // task-1366: the bars are laid out in price units either way (identical glyphs); only the labels are scaled
  const s = opts.scale && Number.isFinite(opts.scale) && opts.scale > 0 ? opts.scale : 1;
  const baseFmt = opts.axisFmt ?? fmtPriceAxis;
  const fmtAxis = s === 1 ? baseFmt : (p: number) => baseFmt(p * s);
  let lo = Infinity, hi = -Infinity, vmax = 0;
  for (const k of data) { lo = Math.min(lo, k.l); hi = Math.max(hi, k.h); vmax = Math.max(vmax, k.v); }
  const pad = (hi - lo) * 0.06 || hi * 0.01;
  lo -= pad; hi += pad;
  const range = hi - lo || 1;
  const rowsOf = (p: number) => (hi - p) / range * plotH; // float row position
  const gridStyle: Style = { fg: mix(bg, t.border, 0.9), bg, soft: true };
  const labelStyle: Style = { fg: t.muted, bg };
  const ticks = Math.max(2, Math.min(6, Math.floor(plotH / 3)));
  for (let i = 0; i <= ticks; i++) {
    const row = Math.round((i / ticks) * (plotH - 1));
    const price = hi - (row / (plotH - 1)) * range;
    for (let k = 0; k < plotW; k++) c.put(x + k, y + row, '·', gridStyle);
    c.textR(x + plotW, y + row, axisW, ' ' + fmtAxis(price), labelStyle);
  }
  // last price line + tag
  const last = data[data.length - 1];
  const lastRow = Math.round(rowsOf(last.c));
  const upLast = last.c >= last.o;
  const lastColor = t.mono ? mix(t.dim, upLast ? t.up : t.down, 0.55) : upLast ? t.up : t.down;
  if (lastRow >= 0 && lastRow < plotH) {
    for (let k = 0; k < plotW; k++) c.put(x + k, y + lastRow, '╌', { fg: mix(bg, lastColor, 0.5), bg, soft: true });
    c.textR(x + plotW, y + lastRow, axisW, ' ' + fmtAxis(last.c), { fg: '#000000', bg: lastColor, b: true });
  }
  const glowOf = (color: Hex) => mix(bg, color, 0.14);
  // mono: direction stays a quiet tint over grey, no white-hot recent bodies, no glow or bloom
  const tone = (col: Hex): Hex => (t.mono ? mix(t.dim, col, 0.55) : col);
  for (let i = 0; i < n; i++) {
    const k = data[i];
    const col = x + i * CW;
    const up = k.c >= k.o;
    const color = tone(up ? t.up : t.down);
    const top = Math.max(k.o, k.c), bot = Math.min(k.o, k.c);
    const rTop = rowsOf(top), rBot = rowsOf(bot);
    const rHi = rowsOf(k.h), rLo = rowsOf(k.l);
    // recent candles burn hotter
    const heat = i / Math.max(1, n - 1);
    const bodyFg = t.mono ? mix(bg, color, 0.62 + 0.38 * heat) : heat > 0.85 ? mix(color, '#ffffff', 0.25) : mix(mix(bg, color, 0.7), color, heat);
    for (let r = Math.floor(rHi); r <= Math.floor(rLo); r++) {
      if (r < 0 || r >= plotH) continue;
      c.put(col + 1, y + r, '│', { fg: mix(bg, color, 0.75), bg, soft: true });
    }
    const bTop = Math.floor(rTop), bBot = Math.floor(rBot);
    const putBody = (r: number, ch: string) => {
      for (let q = 0; q < 3; q++) c.put(col + q, y + r, ch, { fg: bodyFg, bg, soft: true });
      // glow trail into the gap column on the left
      if (!t.mono && col - 1 >= x) { const gi = c.idx(col - 1, y + r); if (c.ch[gi] === ' ' || c.ch[gi] === '·') c.put(col - 1, y + r, '▐', { fg: glowOf(color), bg, soft: true }); }
    };
    if (bTop === bBot) {
      const frac = rTop - bTop;
      const ch = (rBot - rTop) < 0.25 ? '━' : frac < 0.5 ? '▀' : '▄';
      if (bTop >= 0 && bTop < plotH) putBody(bTop, ch);
    } else {
      for (let r = bTop; r <= bBot; r++) {
        if (r < 0 || r >= plotH) continue;
        let ch = '█';
        if (r === bTop && (rTop - bTop) >= 0.5) ch = '▄';
        if (r === bBot && (rBot - bBot) < 0.5) ch = '▀';
        putBody(r, ch);
      }
    }
    // bloom: bg tint one row above and below the body
    for (const r of t.mono ? [] : [bTop - 1, bBot + 1]) {
      if (r < 0 || r >= plotH) continue;
      for (let q = 0; q < 3; q++) { const gi = c.idx(col + q, y + r); if (!c.hard[gi]) c.bg[gi] = mix(bg, color, 0.12); }
    }
  }
  if (volH) {
    const vy = y + plotH;
    for (let i = 0; i < n; i++) {
      const k = data[i];
      const col = x + i * CW;
      const up = k.c >= k.o;
      const color = mix(bg, tone(up ? t.up : t.down), 0.45 + 0.4 * (i / n));
      const units = (k.v / (vmax || 1)) * volH * 8; // eighths
      for (let r = 0; r < volH; r++) {
        const rowFromBottom = volH - 1 - r;
        const rem = units - rowFromBottom * 8;
        if (rem <= 0) continue;
        const lvl = clamp(Math.round(rem), 1, 8);
        for (let q = 0; q < 3; q++) c.put(col + q, vy + r, BLOCKS[lvl - 1], { fg: color, bg, soft: true });
      }
    }
    c.text(x + plotW + 1, vy, 'vol', labelStyle);
    c.text(x + plotW + 1, vy + 1, fmtUsd(last.v, { digits: 1 }), { fg: t.text, bg });
  }
  const ty = y + h - 1;
  const labels = Math.max(2, Math.floor(plotW / 18));
  for (let i = 0; i < labels; i++) {
    const idx = Math.round((i / (labels - 1)) * (n - 1));
    const d = new Date(data[idx].t);
    const lab = `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
    const cx = clamp(x + idx * CW - 4, x, x + plotW - lab.length);
    c.text(cx, ty, lab, labelStyle);
  }
  c.textR(x + plotW, ty, axisW, (opts.interval || '1h') + ' UTC', { fg: t.dim, bg });
}

export interface BarOpts {
  bg?: Hex;
  color?: Hex;
}

/** Horizontal progress bar: gradient fill, hot head cell, one-cell ▓ glow past the head, ░ empty. pct 0..100 */
export function bar(c: Canvas, x: number, y: number, w: number, pct: number, opts: BarOpts = {}): void {
  const t = c.theme;
  const bg = opts.bg || t.panel;
  const color = opts.color || t.accent;
  const filled = Math.round((clamp(pct, 0, 100) / 100) * w);
  for (let i = 0; i < w; i++) {
    const on = i < filled;
    if (on) {
      const u = filled > 1 ? i / (filled - 1) : 1;
      const fg = i === filled - 1 ? mix(color, '#ffffff', 0.35) : mix(mix(bg, color, 0.5), color, u);
      c.put(x + i, y, '█', { fg, bg, soft: true });
    } else if (i === filled && filled > 0) {
      c.put(x + i, y, '▓', { fg: mix(bg, color, 0.35), bg, soft: true });
    } else {
      c.put(x + i, y, '░', { fg: mix(bg, t.border, 0.9), bg, soft: true });
    }
  }
}

/** Two-tone buy/sell ratio bar drawn with ━; both sides brighten toward the meeting point. */
export function ratioBar(c: Canvas, x: number, y: number, w: number, buys: number, sells: number, opts: { bg?: Hex } = {}): void {
  const t = c.theme;
  const bg = opts.bg || t.panel;
  const tot = buys + sells || 1;
  const b = Math.round((buys / tot) * w);
  for (let i = 0; i < w; i++) {
    const isBuy = i < b;
    const color = isBuy ? t.up : t.down;
    const u = isBuy ? (b > 1 ? i / (b - 1) : 1) : (w - b > 1 ? 1 - (i - b) / (w - b - 1) : 1);
    c.put(x + i, y, '━', { fg: mix(mix(bg, color, 0.45), color, u), bg, soft: true });
  }
}

export interface BadgeOpts {
  /** Explicit badge background; default is the semantic color tinted 18 % over `on`. */
  bg?: Hex;
  /** Surface the badge sits on (for the tint). */
  on?: Hex;
  bold?: boolean;
}

/** Text with an 18 % tinted background of its semantic color. Returns the x after the badge. */
export function badge(c: Canvas, x: number, y: number, label: string, fg: Hex, opts: BadgeOpts = {}): number {
  const t = c.theme;
  const bg = opts.bg || mix(opts.on || t.panel, fg, 0.18);
  const s = ` ${label} `;
  c.text(x, y, s, { fg, bg, b: !!opts.bold });
  return x + s.length;
}

const LAUNCHPAD_LABEL: Record<string, string> = { 'pump.fun': 'PUMP', dbc: 'DBC', raydium: 'RAY', meteora: 'MET', bonk: 'BONK' };

export function launchpadBadge(c: Canvas, x: number, y: number, lp: Launchpad | string | null | undefined, opts: BadgeOpts = {}): number {
  const t = c.theme;
  const label = LAUNCHPAD_LABEL[lp ?? ''] || (lp || '—').toUpperCase().slice(0, 4);
  return badge(c, x, y, label, launchpadColor(t, lp), opts);
}

/** Up/down/neutral foreground for a signed number. */
export function pctStyle(c: Canvas, n: number | null | undefined, bg?: Hex): Style {
  const t = c.theme;
  if (n == null) return { fg: t.dim, bg };
  if (n > 0) return { fg: t.up, bg };
  if (n < 0) return { fg: t.down, bg };
  return { fg: t.muted, bg };
}

/** Direction glyph: the second encoding next to colour (colour-blind safe, VISUAL-V2 §6.5). */
export function dirGlyph(n: number): string { return n > 0 ? '▲' : n < 0 ? '▼' : '◆'; }

/** `▲12.3%` / `▼4.0%` / `◆0.0%`; `—` for unknown. */
export function fmtPctDir(n: number | null | undefined, opts: { digits?: number } = {}): string {
  if (n == null || Number.isNaN(n)) return '—';
  return dirGlyph(n) + fmtPct(Math.abs(n), { ...opts, sign: false });
}

/** Signed count with the direction glyph: `▲312`, `▼41`. */
export function fmtDeltaDir(n: number): string { return dirGlyph(n) + Math.abs(n); }

/** Heat-shaded percentage cell: background intensity follows magnitude (cap 40 %); the glyph carries direction; bold above 24 %. */
export function heatPct(c: Canvas, x: number, y: number, w: number, n: number | null | undefined, bg: Hex): void {
  const t = c.theme;
  if (n == null) { c.textR(x, y, w, '—', { fg: t.dim, bg }); return; }
  const mag = clamp(Math.abs(n) / 40, 0, 1);
  // Huge moves (+5,085,307%) would overflow the cell: fall back to a compact K/M form.
  let txt = fmtPctDir(n);
  if (txt.length > w) {
    const a = Math.abs(n);
    txt = dirGlyph(n) + (a >= 1e6 ? `${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M%` : `${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K%`);
  }
  if (t.flat) {
    const fg = n > 0 ? t.up : n < 0 ? t.down : t.muted;
    c.textR(x, y, w, txt, { fg, bg, b: mag >= 1 });
    return;
  }
  const base = n >= 0 ? t.upSoft : t.downSoft;
  const cellBg = mix(bg, base, 0.25 + mag * 0.75);
  const fg = n >= 0 ? t.up : t.down;
  c.fill(x, y, w, 1, ' ', { bg: cellBg });
  c.textR(x, y, w, txt, { fg: mag > 0.6 ? mix(fg, '#ffffff', 0.3) : fg, bg: cellBg, b: mag > 0.6 });
}

export interface CellMeta {
  selected: boolean;
  index: number;
}

export type CellRenderer<R> = (c: Canvas, x: number, y: number, w: number, row: R, bg: Hex, meta: CellMeta) => void;

export interface Column<R> {
  key: string;
  label: string;
  /** Base width in columns. */
  w: number;
  align?: 'left' | 'right';
  /** 0 always shown; higher numbers drop first when the table is narrow. */
  prio: number;
  /** Absorbs leftover width (one column per table). */
  flex?: boolean;
  render: CellRenderer<R>;
}

export interface TableSpec<R> {
  columns: Column<R>[];
  rows: readonly R[];
  selected?: number;
  scroll?: number;
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
  bg?: Hex;
  zebra?: boolean;
}

export interface TableResult {
  /** Keys of the columns that fit, in declaration order. */
  cols: string[];
  rowsVisible: number;
}

/** Table with priority-based column dropping and one flex column. Header, rule, then rows. The area under the last row becomes a quiet rain zone. */
export function table<R>(c: Canvas, x: number, y: number, w: number, h: number, spec: TableSpec<R>): TableResult {
  const t = c.theme;
  const bg = spec.bg || t.panel;
  let cols = spec.columns.slice().sort((a, b) => a.prio - b.prio);
  const gap = 1;
  const fits = (list: Column<R>[]) => list.reduce((s, col) => s + col.w + gap, 0) - gap <= w;
  while (!fits(cols) && cols.length > 1) cols.pop();
  const kept = new Set(cols);
  cols = spec.columns.filter((col) => kept.has(col));
  const used = cols.reduce((s, col) => s + col.w + gap, 0) - gap;
  const flex = cols.find((col) => col.flex);
  const widths = new Map<Column<R>, number>(cols.map((col) => [col, col.w]));
  if (flex && w - used > 0) widths.set(flex, flex.w + (w - used));
  let cx = x;
  const headSt: Style = { fg: t.muted, bg, b: false };
  for (const col of cols) {
    const cw = widths.get(col) as number;
    let label = col.label;
    if (spec.sortKey === col.key) label = (spec.sortDir === 'desc' ? '▼ ' : '▲ ') + label;
    const st: Style = spec.sortKey === col.key ? { fg: t.pop ?? t.accent, bg, b: true } : headSt;
    if (col.align === 'right') c.textR(cx, y, cw, label, st); else c.text(cx, y, label, st, cw);
    cx += cw + gap;
  }
  c.hline(x, y + 1, w, { fg: mix(bg, t.border, 1), bg, soft: true });
  const bodyY = y + 2;
  const rowsVisible = h - 2;
  const start = spec.scroll || 0;
  let drawn = 0;
  for (let r = 0; r < rowsVisible; r++) {
    const ri = start + r;
    const row = spec.rows[ri];
    const ry = bodyY + r;
    if (row === undefined) break;
    drawn += 1;
    const selected = ri === spec.selected;
    const rowBg = selected ? t.selBg : (r % 2 === 1 && spec.zebra !== false ? mix(bg, t.panelAlt, 1) : bg);
    c.fill(x, ry, w, 1, ' ', { bg: rowBg });
    if (selected) c.put(x - 1 >= 0 ? x - 1 : x, ry, '▎', { fg: t.pop ?? t.accent, bg: rowBg, soft: true });
    cx = x;
    for (const col of cols) {
      const cw = widths.get(col) as number;
      col.render(c, cx, ry, cw, row, rowBg, { selected, index: ri });
      cx += cw + gap;
    }
  }
  if (drawn < rowsVisible) c.rainZone(x, bodyY + drawn + 1, w, rowsVisible - drawn - 1, 2);
  return { cols: cols.map((col) => col.key), rowsVisible };
}

export interface StatItem {
  label: string;
  value: string;
  sub?: string;
  style?: Style;
}

/** Key/value stat grid in n columns, two rows per item. Returns the height used. */
export function statGrid(c: Canvas, x: number, y: number, w: number, items: StatItem[], opts: { bg?: Hex; cols?: number } = {}): number {
  const t = c.theme;
  const bg = opts.bg || t.panel;
  const cols = opts.cols || Math.max(1, Math.floor(w / 22));
  const cw = Math.floor(w / cols);
  items.forEach((it, i) => {
    const cx = x + (i % cols) * cw;
    const cy = y + Math.floor(i / cols) * 2;
    c.text(cx, cy, it.label.toUpperCase(), { fg: t.dim, bg }, cw - 1);
    const st: Style = it.style || { fg: t.text, bg, b: true };
    c.text(cx, cy + 1, it.value, { ...st, bg }, cw - 1);
    if (it.sub) c.text(cx + String(it.value).length + 1, cy + 1, it.sub, { fg: t.muted, bg }, cw - 1 - String(it.value).length - 1);
  });
  return Math.ceil(items.length / cols) * 2;
}

export type Hint = readonly [key: string, label: string];

/** Key-cap text colour: black on bright accents, white on dark ones (paper). */
export function onAccent(accent: Hex): Hex { return luminance(accent) > 0.25 ? '#000000' : '#ffffff'; }

/** Footer key hints: accent key cap followed by a label; stops when the next hint would not fit. Returns the x after the last hint. */
export function keyHints(c: Canvas, x: number, y: number, w: number, hints: readonly Hint[], bg: Hex): number {
  const t = c.theme;
  let cx = x;
  for (const [k, label] of hints) {
    if (cx + k.length + label.length + 3 > x + w) break;
    cx = c.text(cx, y, ` ${k} `, { fg: onAccent(t.accent), bg: t.accent, b: true, hard: true });
    cx = c.text(cx, y, ` ${label}  `, { fg: t.muted, bg, hard: true });
  }
  return cx;
}

export interface TapeTrade { side: 'buy' | 'sell'; usd: number }

/**
 * Live trade tape as falling rain lines: each trade owns a column; buys fall green, sells fall red.
 * Newer trades sit nearer the left; the head of each line is the hot ▲/▼ cell; length ∝ log10(usd).
 */
export function tapeRain(c: Canvas, x: number, y: number, w: number, h: number, trades: readonly TapeTrade[], frame: number, opts: { bg?: Hex } = {}): void {
  const t = c.theme;
  const bg = opts.bg || t.panel;
  if (w < 3 || h < 2) return;
  const n = Math.min(trades.length, w);
  for (let k = 0; k < n; k++) {
    const tr = trades[k];
    const col = x + k;
    const color = tr.side === 'buy' ? t.up : t.down;
    const speed = 0.25 + (tr.usd > 2000 ? 0.35 : 0.1);
    const len = Math.min(h, 2 + Math.floor(Math.log10(tr.usd + 1)));
    const period = h + len + 2;
    const head = Math.floor((frame * speed + k * 3.7) % period) - 1;
    for (let j = 0; j < len; j++) {
      const yy = head - j;
      if (yy < 0 || yy >= h) continue;
      const u = 1 - j / len;
      const fg = j === 0 ? mix(color, '#ffffff', 0.4) : mix(mix(bg, color, 0.25), color, u);
      c.put(col, y + yy, j === 0 ? (tr.side === 'buy' ? '▲' : '▼') : '│', { fg, bg, soft: true });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// task-1323: the token screen's BUY/SELL FLOW panel (default) and the trade TAPE list (behind a key).

/** One trade line of the tape list (the live token screen's GeckoTerminal tape). */
export interface TapeRow { t: number; side: 'buy' | 'sell'; usd: number; price: number; wallet: string }

/**
 * Trade tape as a list: age · BUY/SELL · USD · price · wallet, newest first, one trade per line.
 * Draws at most `h` lines; returns the number drawn.
 */
export function tradeTape(c: Canvas, x: number, y: number, w: number, h: number, trades: readonly TapeRow[], now: number, opts: { bg?: Hex } = {}): number {
  const t = c.theme;
  const bg = opts.bg || t.panel;
  let n = 0;
  for (const tr of trades) {
    if (n >= h) break;
    const yy = y + n;
    const color = tr.side === 'buy' ? t.up : t.down;
    let cx = c.text(x, yy, fmtAgeSec(Math.max(0, (now - tr.t) / 1000)).padStart(4), { fg: t.dim, bg }, w);
    cx = c.text(cx + 1, yy, tr.side === 'buy' ? 'BUY ' : 'SELL', { fg: color, bg, b: true }, Math.max(0, x + w - cx - 1));
    if (cx + 9 > x + w) { n += 1; continue; }
    cx = c.textR(cx + 1, yy, 8, fmtUsd(tr.usd), { fg: t.text, bg });
    cx = c.text(cx + 2, yy, tr.price > 0 ? fmtPrice(tr.price) : '—', { fg: t.muted, bg }, Math.max(0, x + w - cx - 2));
    c.text(cx + 2, yy, shortAddr(tr.wallet, 3), { fg: t.dim, bg }, Math.max(0, x + w - cx - 2));
    n += 1;
  }
  return n;
}

/** Trend cell of a flow row: a direction vs the previous same-length window, or why there is none. */
export type FlowTrendCell =
  | { dir: 1 | -1 | 0; deltaPts: number }
  /** The previous window is still being collected; `wait` is the time left, e.g. '3m'. */
  | { wait: string }
  /** No comparison possible (no trades in a window, tape too short); `na` says why in a word. */
  | { na: string };

/** One timeframe row of the buy/sell flow panel. Numbers are what a source said; null = not reported. */
export interface FlowPanelRow {
  label: string;
  buys: number | null;
  sells: number | null;
  /** Per-side USD, only when the source splits volume by side (the tape does; DexScreener does not). */
  buyUsd: number | null;
  sellUsd: number | null;
  /** Total USD volume for the window. */
  volUsd: number | null;
  /** Counts are a lower bound: the source did not cover the whole window. */
  partial?: boolean;
  trend: FlowTrendCell;
  /** Replaces the numbers when the window has no data at all ('loading tape…', 'no dexscreener pair'). */
  note?: string | null;
}

/** buys ÷ sells: Infinity when only buys, null when nothing traded (or unknown). */
export function flowRatio(buys: number | null, sells: number | null): number | null {
  if (buys === null || sells === null || buys + sells <= 0) return null;
  if (sells === 0) return Infinity;
  return buys / sells;
}

/** `1.71×` · `∞` (only buys) · `0.00×` (only sells) · `—` (nothing traded). */
export function fmtFlowRatio(r: number | null): string {
  if (r === null || Number.isNaN(r)) return '—';
  if (r === Infinity) return '∞';
  return r >= 100 ? `${Math.round(r)}×` : `${r.toFixed(2)}×`;
}

/** Cells of a `w`-wide ratio bar painted as BUY (the rest are SELL); 0 when nothing traded. */
export function buyCells(w: number, buys: number | null, sells: number | null): number {
  if (buys === null || sells === null || buys + sells <= 0 || w <= 0) return 0;
  return Math.round((buys / (buys + sells)) * w);
}

/** `▲ +6pt` / `▼ -3pt` / `◆ flat` / `wait 3m` / the n/a reason. */
export function fmtFlowTrend(cell: FlowTrendCell): string {
  if ('wait' in cell) return `wait ${cell.wait}`;
  if ('na' in cell) return cell.na;
  if (cell.dir === 0) return '◆ flat';
  return `${cell.dir > 0 ? '▲' : '▼'} ${cell.deltaPts > 0 ? '+' : cell.deltaPts < 0 ? '-' : ''}${Math.abs(cell.deltaPts)}pt`;
}

function fmtCount(n: number | null, partial: boolean): string {
  if (n === null) return '—';
  return (n >= 10_000 ? fmtNum(n) : String(Math.round(n))) + (partial ? '+' : '');
}

/**
 * The BUY/SELL FLOW table: a header row, then one row per timeframe — buy and sell COUNT, the buy share
 * as a two-tone bar, buys÷sells as a number, USD volume (split buy/sell when the source splits it and
 * there is room), and the trend vs the previous same-length window. The bar is the flex column; the
 * volume column drops first when the panel is narrow. Returns the number of lines drawn.
 */
export function flowPanel(c: Canvas, x: number, y: number, w: number, h: number, rows: readonly FlowPanelRow[], opts: { bg?: Hex } = {}): number {
  const t = c.theme;
  const bg = opts.bg || t.panel;
  if (h < 1 || w < 24) return 0;
  const labW = 3, cntW = 5, ratW = 5, trW = 9;
  const split = w >= 64 && rows.some((r) => r.buyUsd !== null);
  let volW = split ? 15 : 7;
  let barW = w - (labW + 1 + cntW + 1 + cntW + 1 + 1 + ratW + 1 + volW + 1 + trW);
  if (barW < 4) { barW += volW + 1; volW = 0; }
  barW = Math.max(1, barW);
  const xB = x + labW + 1, xS = xB + cntW + 1, xBar = xS + cntW + 1, xR = xBar + barW + 1, xV = xR + ratW + 1, xT = xV + (volW ? volW + 1 : 0);
  const head = { fg: t.dim, bg };
  c.text(x, y, 'WIN', head);
  c.textR(xB, y, cntW, 'BUYS', head);
  c.textR(xS, y, cntW, 'SELLS', head);
  c.text(xBar, y, barW >= 10 ? 'buy ━ sell' : 'b━s', head, barW);
  c.textR(xR, y, ratW, 'B:S', head);
  if (volW) c.textR(xV, y, volW, split ? 'USD VOL B/S' : 'USD VOL', head);
  c.text(xT, y, 'TREND', head, x + w - xT);
  let n = 1;
  for (const r of rows) {
    if (n >= h) break;
    const yy = y + n;
    c.text(x, yy, r.label, { fg: t.muted, bg, b: true }, labW);
    if (r.note) {
      c.text(xB, yy, r.note, { fg: t.dim, bg, i: true }, x + w - xB);
      n += 1;
      continue;
    }
    const partial = !!r.partial;
    c.textR(xB, yy, cntW, fmtCount(r.buys, partial), { fg: r.buys ? t.up : t.dim, bg });
    c.textR(xS, yy, cntW, fmtCount(r.sells, partial), { fg: r.sells ? t.down : t.dim, bg });
    if (buyCells(barW, r.buys, r.sells) === 0 && flowRatio(r.buys, r.sells) === null) {
      for (let i = 0; i < barW; i++) c.put(xBar + i, yy, '─', { fg: mix(bg, t.border, 0.9), bg, soft: true });
    } else {
      ratioBar(c, xBar, yy, barW, r.buys ?? 0, r.sells ?? 0, { bg });
    }
    const ratio = flowRatio(r.buys, r.sells);
    c.textR(xR, yy, ratW, fmtFlowRatio(ratio), { fg: ratio === null ? t.dim : ratio > 1 ? t.up : ratio < 1 ? t.down : t.muted, bg, b: ratio !== null });
    if (volW) {
      if (split && r.buyUsd !== null && r.sellUsd !== null) {
        const bs = fmtUsd(r.buyUsd, { digits: 2 }), ss = fmtUsd(r.sellUsd, { digits: 2 });
        const sx = xV + volW - ss.length;
        c.text(sx, yy, ss, { fg: t.down, bg });
        c.text(sx - 1, yy, '/', { fg: t.dim, bg });
        c.textR(xV, yy, Math.max(0, sx - 1 - xV), bs, { fg: t.up, bg });
      } else {
        c.textR(xV, yy, volW, r.volUsd === null ? '—' : fmtUsd(r.volUsd, { digits: 2 }), { fg: r.volUsd === null ? t.dim : t.text, bg });
      }
    }
    const tc = r.trend;
    const tst: Style = 'dir' in tc
      ? { fg: tc.dir > 0 ? t.up : tc.dir < 0 ? t.down : t.muted, bg, b: tc.dir !== 0 }
      : { fg: t.dim, bg, i: true };
    c.text(xT, yy, fmtFlowTrend(tc), tst, x + w - xT);
    n += 1;
  }
  return n;
}

export { fmtNum };
