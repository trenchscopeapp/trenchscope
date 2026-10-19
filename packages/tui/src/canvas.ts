// @dexterm/tui — cell-buffer canvas with plain, ANSI (24-bit / 256 / none) and HTML emitters.
// Every glyph drawn is single-column (box drawing, blocks, braille, half-width katakana), so x == column.
//
// Two masks make the cyberspace practicality rules mechanical (VISUAL-V2 §3):
//   `hard[i]`  set by put() for any data glyph (digits, letters, $ % ▲ ▼ …) unless the writer says
//              `soft: true` (borders, blocks, braille, rain). Effects write through putFx(), which
//              refuses hard cells and non-blank cells: no effect can overdraw a number by construction.
//   `zone[i]`  1 = band/gutter (full-brightness rain), 2 = panel interior (dim rain), 0 = never rains.
//              Screens opt areas in with rainZone(); widgets opt the area under their last row in.
// `headings` are rects (box titles, logo, section caps) that may take the chromatic colour split.
import { hexToRgb, hexToAnsi256, mix, type ColorDepth, type Hex } from './color.ts';
import type { Theme } from './theme.ts';

/** Cell style. b bold, d dim, i italic, u underline. Unset fg/bg keep the cell's current color. */
export interface Style {
  fg?: Hex;
  bg?: Hex;
  b?: boolean;
  d?: boolean;
  i?: boolean;
  u?: boolean;
  /** Decorative glyph (border, block, rain): never marked hard even when it matches a data glyph. */
  soft?: boolean;
  /** Force the hard mask (key-hint chips, labels made of punctuation). */
  hard?: boolean;
  /** putFx only: allow writing over a non-blank soft cell. */
  overwrite?: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoxOpts {
  title?: string;
  caption?: string;
  focus?: boolean;
  border?: Hex;
  bg?: Hex;
  titleFg?: Hex;
  captionFg?: Hex;
  rounded?: boolean;
  /** task-1340: no heading is registered, so the title never takes the chromatic colour split (the trade ticket). */
  plain?: boolean;
}

export interface InnerRect extends Rect {
  bg: Hex;
}

/** A recorded pixel-image slot (see images/layer.ts). Pixels are straight-alpha RGBA8. */
export interface ImageSlotRecord extends Rect {
  key: string;
  img: { w: number; h: number; rgba: Uint8Array };
  png?: Uint8Array | null;
}

export interface AnsiOpts {
  /** Prefix with cursor-home so the frame overwrites the previous one. */
  home?: boolean;
  depth?: ColorDepth;
}

export interface HtmlOpts {
  title?: string;
  fontPx?: number;
  /** Draw the macOS-style window bar around the frame. */
  chrome?: boolean;
  /** Video frame: fixed page size, canvas centred, no window chrome. */
  fit?: { width: number; height: number } | null;
  /** task-1326: render every colour through the xterm-256 palette (what a 256-colour terminal shows). */
  depth?: ColorDepth;
}

export const ATTR_BOLD = 1;
export const ATTR_DIM = 2;
export const ATTR_ITALIC = 4;
export const ATTR_UNDERLINE = 8;

/** Data glyphs: anything carrying a value or a label the trader reads. Effects never overdraw these. */
const HARD_RE = /[0-9A-Za-z$%+\-.,:/…₀-₉▲▼✓✗●◐○•›↳⏎⌕◉◌✦#§'"?!()<>=×_|]/;
export function isHardGlyph(ch: string): boolean { return HARD_RE.test(ch); }

/** SGR sequence for one cell style at the given depth. Exported so the flusher shares it. */
export function sgr(fg: Hex, bg: Hex, at: number, depth: ColorDepth): string {
  let seq = '\x1b[0';
  if (at & ATTR_BOLD) seq += ';1';
  if (at & ATTR_DIM) seq += ';2';
  if (at & ATTR_ITALIC) seq += ';3';
  if (at & ATTR_UNDERLINE) seq += ';4';
  if (depth === 'truecolor') {
    const [r, g, b] = hexToRgb(fg);
    const [r2, g2, b2] = hexToRgb(bg);
    seq += `;38;2;${r};${g};${b};48;2;${r2};${g2};${b2}`;
  } else if (depth === '256') {
    seq += `;38;5;${hexToAnsi256(fg)};48;5;${hexToAnsi256(bg)}`;
  }
  return seq + 'm';
}

export class Canvas {
  readonly w: number;
  readonly h: number;
  readonly theme: Theme;
  ch: string[];
  fg: Hex[];
  bg: Hex[];
  /** bit0 bold, bit1 dim, bit2 italic, bit3 underline */
  at: Uint8Array;
  /** 1 = data glyph; effects never touch it. */
  hard: Uint8Array;
  /** 0 never rains, 1 band/gutter (bright), 2 panel interior (dim). */
  zone: Uint8Array;
  /** Heading rects eligible for the chromatic colour split. */
  headings: Rect[];
  /**
   * task-1340: 1 = a cell NO effect may touch at all (the trade ticket in every phase, the caps line, the result
   * card): putFx / tintFx refuse it, datamosh skips it as source and destination, scanlines skip it, and the
   * whole-frame shake is disabled while any shield exists. `shields` keeps the rects for tests.
   */
  shield: Uint8Array;
  shields: Rect[];
  /**
   * task-1326: image slots recorded by coinImage() when `imageMode` is 'pixels' — cell boxes a pixel
   * protocol (kitty / iTerm2 / sixel) paints over after the flush. Empty in 'cells' mode (block art is
   * drawn straight into the cells). Not part of the plain/ANSI emitters.
   */
  images: ImageSlotRecord[];
  imageMode: 'cells' | 'pixels';

  constructor(w: number, h: number, theme: Theme) {
    this.w = w;
    this.h = h;
    this.theme = theme;
    const n = w * h;
    this.ch = new Array<string>(n).fill(' ');
    this.fg = new Array<Hex>(n).fill(theme.text);
    this.bg = new Array<Hex>(n).fill(theme.bg);
    this.at = new Uint8Array(n);
    this.hard = new Uint8Array(n);
    this.zone = new Uint8Array(n);
    this.headings = [];
    this.shield = new Uint8Array(n);
    this.shields = [];
    this.images = [];
    this.imageMode = 'cells';
  }

  idx(x: number, y: number): number { return y * this.w + x; }

  /** Copy every buffer of `src` (same size) into this canvas. */
  copyFrom(src: Canvas): void {
    this.ch = src.ch.slice();
    this.fg = src.fg.slice();
    this.bg = src.bg.slice();
    this.at = src.at.slice();
    this.hard = src.hard.slice();
    this.zone = src.zone.slice();
    this.headings = src.headings.slice();
    this.shield = src.shield.slice();
    this.shields = src.shields.slice();
    this.images = src.images.slice();
    this.imageMode = src.imageMode;
  }

  put(x: number, y: number, ch: string, st: Style = {}): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = this.idx(x, y);
    this.ch[i] = ch;
    if (st.fg) this.fg[i] = st.fg;
    if (st.bg) this.bg[i] = st.bg;
    this.at[i] = (st.b ? ATTR_BOLD : 0) | (st.d ? ATTR_DIM : 0) | (st.i ? ATTR_ITALIC : 0) | (st.u ? ATTR_UNDERLINE : 0);
    this.hard[i] = st.soft ? 0 : (st.hard || HARD_RE.test(ch)) ? 1 : 0;
  }

  /** Effects-only writer: refuses hard cells, non-blank cells (unless `overwrite`) and, with needZone, cells outside rain zones. */
  putFx(x: number, y: number, ch: string, st: Style = {}, needZone = false): boolean {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    const i = this.idx(x, y);
    if (this.hard[i] || this.shield[i]) return false;
    if (needZone && !this.zone[i]) return false;
    if (this.ch[i] !== ' ' && !st.overwrite) return false;
    this.ch[i] = ch;
    if (st.fg) this.fg[i] = st.fg;
    if (st.bg) this.bg[i] = st.bg;
    this.at[i] = (st.b ? ATTR_BOLD : 0) | (st.d ? ATTR_DIM : 0);
    return true;
  }

  /** Effects-only background tint (task-1340): refuses hard and shielded cells, so a number's contrast never moves. */
  tintFx(x: number, y: number, color: Hex, amount: number): boolean {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    const i = this.idx(x, y);
    if (this.hard[i] || this.shield[i]) return false;
    this.bg[i] = mix(this.bg[i], color, amount);
    return true;
  }

  /** Shield a rect from every effect pass (task-1340: the trade ticket). */
  shieldRect(x: number, y: number, w: number, h: number): void {
    this.shields.push({ x, y, w, h });
    for (let j = 0; j < h; j++) for (let k = 0; k < w; k++) {
      const xx = x + k, yy = y + j;
      if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) continue;
      this.shield[this.idx(xx, yy)] = 1;
    }
  }

  get hasShield(): boolean { return this.shields.length > 0; }

  /** Draw text left-aligned at (x, y), clipped to maxW columns. Returns the x after the text. */
  text(x: number, y: number, str: unknown, st: Style = {}, maxW = Infinity): number {
    const s = String(str);
    const lim = Math.min(s.length, maxW);
    for (let k = 0; k < lim; k++) this.put(x + k, y, s[k], st);
    return x + lim;
  }

  /** Right-aligned text within [x, x+w). */
  textR(x: number, y: number, w: number, str: unknown, st: Style = {}): number {
    const s = String(str).slice(0, w);
    return this.text(x + w - s.length, y, s, st);
  }

  /** Centered text within [x, x+w). */
  textC(x: number, y: number, w: number, str: unknown, st: Style = {}): number {
    const s = String(str).slice(0, w);
    return this.text(x + Math.floor((w - s.length) / 2), y, s, st);
  }

  fill(x: number, y: number, w: number, h: number, ch = ' ', st: Style = {}): void {
    for (let j = 0; j < h; j++) for (let k = 0; k < w; k++) this.put(x + k, y + j, ch, st);
  }

  /** Paint background only, keep glyphs. */
  shade(x: number, y: number, w: number, h: number, bg: Hex): void {
    for (let j = 0; j < h; j++) {
      for (let k = 0; k < w; k++) {
        const xx = x + k, yy = y + j;
        if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) continue;
        this.bg[this.idx(xx, yy)] = bg;
      }
    }
  }

  /** Mark a rect as rain-eligible. kind 1 = band/gutter (full brightness), 2 = panel interior (dim). Only blank cells rain. */
  rainZone(x: number, y: number, w: number, h: number, kind: 1 | 2 = 1): void {
    for (let j = 0; j < h; j++) {
      for (let k = 0; k < w; k++) {
        const xx = x + k, yy = y + j;
        if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) continue;
        this.zone[this.idx(xx, yy)] = kind;
      }
    }
  }

  /** Clear the rain mask over a rect (logos, status boxes, toasts). */
  noRain(x: number, y: number, w: number, h: number): void {
    for (let j = 0; j < h; j++) {
      for (let k = 0; k < w; k++) {
        const xx = x + k, yy = y + j;
        if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) continue;
        this.zone[this.idx(xx, yy)] = 0;
      }
    }
  }

  /** Record a heading rect so fx can chromatic-aberrate it (ghost glyphs land only in blank neighbours). */
  heading(x: number, y: number, w: number): void { this.headings.push({ x, y, w, h: 1 }); }

  hline(x: number, y: number, w: number, st: Style = {}, ch = '─'): void { for (let k = 0; k < w; k++) this.put(x + k, y, ch, st); }
  vline(x: number, y: number, h: number, st: Style = {}, ch = '│'): void { for (let k = 0; k < h; k++) this.put(x, y + k, ch, st); }

  /** Panel box with optional title and right-side caption. Returns the inner rect. */
  box(x: number, y: number, w: number, h: number, opts: BoxOpts = {}): InnerRect {
    const t = this.theme;
    const bg = opts.bg || t.panel;
    const bc = opts.focus ? t.borderFocus : (opts.border || t.border);
    const st: Style = { fg: bc, bg };
    this.fill(x, y, w, h, ' ', { bg });
    const r = opts.rounded !== false;
    this.put(x, y, r ? '╭' : '┌', st);
    this.put(x + w - 1, y, r ? '╮' : '┐', st);
    this.put(x, y + h - 1, r ? '╰' : '└', st);
    this.put(x + w - 1, y + h - 1, r ? '╯' : '┘', st);
    this.hline(x + 1, y, w - 2, st);
    this.hline(x + 1, y + h - 1, w - 2, st);
    this.vline(x, y + 1, h - 2, st);
    this.vline(x + w - 1, y + 1, h - 2, st);
    const title = opts.title ? ` ${opts.title} ` : '';
    const cap = opts.caption ? ` ${opts.caption} ` : '';
    // Title always wins; caption is dropped when both do not fit.
    const showCap = cap && (title.length + cap.length + 6 <= w);
    if (title) {
      this.text(x + 2, y, title, { fg: opts.focus ? t.borderFocus : (opts.titleFg || t.text), bg, b: true }, w - 4);
      if (!opts.plain) this.heading(x + 2, y, Math.min(title.length, w - 4));
    }
    if (showCap) this.text(x + w - 2 - cap.length, y, cap, { fg: opts.captionFg || t.muted, bg }, w - 4);
    return { x: x + 1, y: y + 1, w: w - 2, h: h - 2, bg };
  }

  // ---------- emitters ----------

  /** One row as plain text, trailing whitespace trimmed. */
  rowPlain(y: number): string {
    let line = '';
    for (let x = 0; x < this.w; x++) line += this.ch[this.idx(x, y)];
    return line.replace(/\s+$/, '');
  }

  /** Monochrome text render (the snapshot-test surface). */
  toPlain(): string {
    const rows: string[] = [];
    for (let y = 0; y < this.h; y++) rows.push(this.rowPlain(y));
    return rows.join('\n');
  }

  /** One row as ANSI with a trailing reset; styles are re-emitted at the start of the row. */
  rowAnsi(y: number, depth: ColorDepth = 'truecolor'): string {
    let row = '';
    let pfg: Hex | null = null, pbg: Hex | null = null, pat = -1;
    for (let x = 0; x < this.w; x++) {
      const i = this.idx(x, y);
      const fg = this.fg[i], bg = this.bg[i], at = this.at[i];
      if (depth === 'none') {
        // Colors dropped; attributes still carry emphasis. Collapse color-only changes.
        if (at !== pat) { row += sgr(fg, bg, at, depth); pat = at; }
      } else if (fg !== pfg || bg !== pbg || at !== pat) {
        row += sgr(fg, bg, at, depth);
        pfg = fg; pbg = bg; pat = at;
      }
      row += this.ch[i];
    }
    return row + '\x1b[0m';
  }

  /** Full-frame ANSI render. */
  toAnsi({ home = false, depth = 'truecolor' }: AnsiOpts = {}): string {
    let out = home ? '\x1b[H' : '';
    for (let y = 0; y < this.h; y++) {
      out += this.rowAnsi(y, depth) + (y < this.h - 1 ? '\n' : '');
    }
    return out;
  }

  /**
   * Standalone HTML page (screenshots, design review, video frames). Cell-exact: per-cell fg/bg only,
   * every run pinned to `N ch` so a glyph that falls back to another font cannot shift the grid.
   */
  toHtml({ title = 'dexterm', fontPx = 15, chrome = true, fit = null, depth = 'truecolor' }: HtmlOpts = {}): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const t = this.theme;
    // 256-colour proof: map each hex to the xterm cube/grey entry its SGR index would select
    const pal = (hex: Hex): Hex => {
      if (depth !== '256') return hex;
      const i = hexToAnsi256(hex);
      if (i >= 232) { const v = 8 + 10 * (i - 232); return '#' + [v, v, v].map((n) => n.toString(16).padStart(2, '0')).join(''); }
      const k = i - 16, cube = [0, 95, 135, 175, 215, 255];
      return '#' + [cube[Math.floor(k / 36)], cube[Math.floor(k / 6) % 6], cube[k % 6]].map((n) => n.toString(16).padStart(2, '0')).join('');
    };
    let body = '';
    for (let y = 0; y < this.h; y++) {
      let run = '', pk: string | null = null, line = '';
      const flush = () => {
        if (!run || pk === null) return;
        const [fg, bg, at] = pk.split('|');
        const a = Number(at);
        let style = `color:${fg};background:${bg};width:${run.length}ch;overflow:hidden;`;
        if (a & ATTR_BOLD) style += 'font-weight:700;';
        if (a & ATTR_DIM) style += 'opacity:.6;';
        if (a & ATTR_ITALIC) style += 'font-style:italic;';
        if (a & ATTR_UNDERLINE) style += 'text-decoration:underline;';
        line += `<span style="${style}">${esc(run)}</span>`;
        run = '';
      };
      for (let x = 0; x < this.w; x++) {
        const i = this.idx(x, y);
        const k = `${pal(this.fg[i])}|${pal(this.bg[i])}|${this.at[i]}`;
        if (k !== pk) { flush(); pk = k; }
        run += this.ch[i];
      }
      flush();
      body += line + '\n';
    }
    const lh = Math.round(fontPx * 1.3);
    const font = `font-family:'JetBrains Mono','SF Mono',Menlo,Monaco,'Cascadia Code',monospace;font-size:${fontPx}px;line-height:${lh}px;font-variant-ligatures:none;`;
    if (fit) {
      return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  html,body{margin:0;padding:0;background:${t.bg};width:${fit.width}px;height:${fit.height}px;overflow:hidden;}
  body{display:flex;align-items:center;justify-content:center;}
  pre{margin:0;${font}background:${t.bg};color:${t.text};white-space:pre;}
  pre span{display:inline-block;height:${lh}px;vertical-align:top;}
</style></head><body><pre>${body}</pre></body></html>`;
    }
    const chromeHtml = chrome
      ? `<div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="ttl">${esc(title)}</span></div>`
      : '';
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  html,body{margin:0;padding:0;background:#05070a;}
  body{padding:28px;display:inline-block;}
  .win{display:inline-block;border-radius:12px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.06);background:${t.bg};}
  .bar{height:34px;background:${t.headBg};display:flex;align-items:center;padding:0 14px;gap:8px;border-bottom:1px solid ${t.border};}
  .dot{width:12px;height:12px;border-radius:50%;display:inline-block}
  .dot.r{background:#ff5f57}.dot.y{background:#febc2e}.dot.g{background:#28c840}
  .ttl{margin-left:auto;margin-right:auto;color:${t.muted};font:500 12px -apple-system,'SF Pro Text',Inter,system-ui,sans-serif;letter-spacing:.2px}
  pre{margin:0;padding:10px 12px 12px 12px;${font}background:${t.bg};color:${t.text};white-space:pre;}
  pre span{display:inline-block;height:${lh}px;vertical-align:top;}
</style></head><body><div class="win">${chromeHtml}<pre>${body}</pre></div></body></html>`;
  }
}
