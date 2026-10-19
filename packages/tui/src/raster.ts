// @dexterm/tui — rasterize a Canvas to straight-alpha RGBA pixels (task-1401, the share/export key). Pure TypeScript,
// no font file and no browser: text uses the 5×9 bitmap font in raster-font.ts; box drawing, block elements, shades
// and braille are drawn procedurally so borders join and charts read like they do in a terminal. Recorded pixel
// image slots (coin images in kitty/iTerm2/sixel mode) are painted into their cell rects. Unknown glyphs draw as a
// small hollow box (never a crash, never a dropped cell).
import type { Canvas } from './canvas.ts';
import { ATTR_BOLD, ATTR_DIM, ATTR_UNDERLINE } from './canvas.ts';
import { hexToRgb, mix, type Hex } from './color.ts';
import { glyphBits, FONT_W, FONT_H } from './raster-font.ts';

export interface RgbaPixels { w: number; h: number; rgba: Uint8Array }

export interface RasterOpts {
  /** Pixel size of one terminal cell. Default 12×24. */
  cellW?: number;
  cellH?: number;
  /** Font pixel scale (the 5×9 font at 2 = 10×18 inside the cell). Default 2. */
  scale?: number;
}

type Rgb = readonly [number, number, number];

class Px {
  readonly w: number; readonly h: number; readonly rgba: Uint8Array;
  constructor(w: number, h: number) { this.w = w; this.h = h; this.rgba = new Uint8Array(w * h * 4); }
  rect(x: number, y: number, w: number, h: number, c: Rgb, a = 1): void {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.w, Math.floor(x + w)), y1 = Math.min(this.h, Math.floor(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
      const i = (yy * this.w + xx) * 4;
      if (a >= 1) { this.rgba[i] = c[0]; this.rgba[i + 1] = c[1]; this.rgba[i + 2] = c[2]; }
      else { this.rgba[i] = Math.round(this.rgba[i] * (1 - a) + c[0] * a); this.rgba[i + 1] = Math.round(this.rgba[i + 1] * (1 - a) + c[1] * a); this.rgba[i + 2] = Math.round(this.rgba[i + 2] * (1 - a) + c[2] * a); }
      this.rgba[i + 3] = 255;
    }
  }
}

// Box drawing: up, down, left, right weights (0 none, 1 light, 2 heavy/double) and a dashed flag.
const BOX: Record<string, string> = {
  '─': '0011', '━': '0022', '│': '1100', '┃': '2200',
  '┌': '0101', '╭': '0101', '┐': '0110', '╮': '0110', '└': '1001', '╰': '1001', '┘': '1010', '╯': '1010',
  '┏': '0202', '┓': '0220', '┗': '2002', '┛': '2020',
  '├': '1101', '┤': '1110', '┬': '0111', '┴': '1011', '┼': '1111',
  '┣': '2202', '┫': '2220', '┳': '0222', '┻': '2022', '╋': '2222',
  '═': '0022', '║': '2200', '╔': '0202', '╗': '0220', '╚': '2002', '╝': '2020', '╠': '2202', '╣': '2220', '╦': '0222', '╩': '2022', '╬': '2222',
  '╴': '0010', '╵': '1000', '╶': '0001', '╷': '0100', '╸': '0020', '╹': '2000', '╺': '0002', '╻': '0200',
};
const DASH_H = new Set(['┄', '┅', '┈', '┉', '╌', '╍']);
const DASH_V = new Set(['┆', '┇', '┊', '┋', '╎', '╏']);
const EIGHTHS_LOW = '▁▂▃▄▅▆▇█';
const EIGHTHS_LEFT = '▏▎▍▌▋▊▉█';
const SHADES: Record<string, number> = { '░': 0.25, '▒': 0.5, '▓': 0.75 };
// Quadrants: TL, TR, BL, BR.
const QUAD: Record<string, [number, number, number, number]> = {
  '▘': [1, 0, 0, 0], '▝': [0, 1, 0, 0], '▖': [0, 0, 1, 0], '▗': [0, 0, 0, 1], '▚': [1, 0, 0, 1], '▞': [0, 1, 1, 0],
  '▛': [1, 1, 1, 0], '▜': [1, 1, 0, 1], '▙': [1, 0, 1, 1], '▟': [0, 1, 1, 1], '▀': [1, 1, 0, 0], '▄': [0, 0, 1, 1], '▌': [1, 0, 1, 0], '▐': [0, 1, 0, 1],
};

/** Draw one non-text glyph procedurally. Returns false when the glyph is not one of these families. */
function drawSpecial(p: Px, ch: string, x: number, y: number, cw: number, chh: number, fg: Rgb, bg: Rgb, scale: number): boolean {
  const box = BOX[ch];
  if (box) {
    const t1 = Math.max(1, scale), t2 = Math.max(2, scale * 2);
    const [u, d, l, r] = [...box].map(Number);
    const cx = x + Math.floor(cw / 2), cy = y + Math.floor(chh / 2);
    const th = (wgt: number) => (wgt === 2 ? t2 : t1);
    const hT = Math.max(th(l), th(r)), vT = Math.max(th(u), th(d));
    if (l) p.rect(x, cy - Math.floor(th(l) / 2), cx - x + Math.ceil(vT / 2), th(l), fg);
    if (r) p.rect(cx - Math.floor(vT / 2), cy - Math.floor(th(r) / 2), x + cw - (cx - Math.floor(vT / 2)), th(r), fg);
    if (u) p.rect(cx - Math.floor(th(u) / 2), y, th(u), cy - y + Math.ceil(hT / 2), fg);
    if (d) p.rect(cx - Math.floor(th(d) / 2), cy - Math.floor(hT / 2), th(d), y + chh - (cy - Math.floor(hT / 2)), fg);
    return true;
  }
  if (DASH_H.has(ch)) { const t = Math.max(1, scale); const seg = Math.max(2, Math.floor(cw / 4)); for (let k = 0; k < cw; k += seg * 2) p.rect(x + k, y + Math.floor(chh / 2) - Math.floor(t / 2), seg, t, fg); return true; }
  if (DASH_V.has(ch)) { const t = Math.max(1, scale); const seg = Math.max(2, Math.floor(chh / 6)); for (let k = 0; k < chh; k += seg * 2) p.rect(x + Math.floor(cw / 2) - Math.floor(t / 2), y + k, t, seg, fg); return true; }
  const low = EIGHTHS_LOW.indexOf(ch);
  if (low >= 0) { const hh = Math.round((chh * (low + 1)) / 8); p.rect(x, y + chh - hh, cw, hh, fg); return true; }
  const left = EIGHTHS_LEFT.indexOf(ch);
  if (left >= 0) { p.rect(x, y, Math.round((cw * (left + 1)) / 8), chh, fg); return true; }
  if (ch === '▔') { p.rect(x, y, cw, Math.max(1, Math.round(chh / 8)), fg); return true; }
  if (ch === '▕') { const ww = Math.max(1, Math.round(cw / 8)); p.rect(x + cw - ww, y, ww, chh, fg); return true; }
  const shade = SHADES[ch];
  if (shade !== undefined) { p.rect(x, y, cw, chh, [Math.round(bg[0] + (fg[0] - bg[0]) * shade), Math.round(bg[1] + (fg[1] - bg[1]) * shade), Math.round(bg[2] + (fg[2] - bg[2]) * shade)]); return true; }
  const q = QUAD[ch];
  if (q) {
    const hw = Math.floor(cw / 2), hh = Math.floor(chh / 2);
    if (q[0]) p.rect(x, y, hw, hh, fg);
    if (q[1]) p.rect(x + hw, y, cw - hw, hh, fg);
    if (q[2]) p.rect(x, y + hh, hw, chh - hh, fg);
    if (q[3]) p.rect(x + hw, y + hh, cw - hw, chh - hh, fg);
    return true;
  }
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x2800 && code <= 0x28ff) {
    const bits = code - 0x2800;
    // dot n → (column, row): 1(0,0) 2(0,1) 3(0,2) 4(1,0) 5(1,1) 6(1,2) 7(0,3) 8(1,3)
    const dots: Array<[number, number, number]> = [[0x01, 0, 0], [0x02, 0, 1], [0x04, 0, 2], [0x08, 1, 0], [0x10, 1, 1], [0x20, 1, 2], [0x40, 0, 3], [0x80, 1, 3]];
    const dw = Math.max(1, Math.floor(cw / 4)), dh = Math.max(1, Math.floor(chh / 8));
    for (const [bit, col, row] of dots) if (bits & bit) p.rect(x + Math.floor((cw * (col * 2 + 1)) / 4) - Math.floor(dw / 2), y + Math.floor((chh * (row * 2 + 1)) / 8) - Math.floor(dh / 2), dw, dh, fg);
    return true;
  }
  if (ch === '╱' || ch === '╲' || ch === '╳') {
    const t = Math.max(1, scale);
    for (let k = 0; k < chh; k++) {
      const fx = Math.floor((k * cw) / chh);
      if (ch !== '╲') p.rect(x + cw - 1 - fx - Math.floor(t / 2), y + k, t, 1, fg);
      if (ch !== '╱') p.rect(x + fx - Math.floor(t / 2), y + k, t, 1, fg);
    }
    return true;
  }
  return false;
}

/** Rasterize every cell of a canvas: background, glyph (font or procedural), attributes, then image slots. */
export function rasterizeCanvas(c: Canvas, opts: RasterOpts = {}): RgbaPixels {
  const cw = opts.cellW ?? 12, chh = opts.cellH ?? 24, scale = opts.scale ?? 2;
  const p = new Px(c.w * cw, c.h * chh);
  const gx = Math.floor((cw - FONT_W * scale) / 2), gy = Math.floor((chh - FONT_H * scale) / 2);
  const rgbCache = new Map<string, Rgb>();
  const rgb = (h: Hex): Rgb => { let v = rgbCache.get(h); if (!v) { v = hexToRgb(h); rgbCache.set(h, v); } return v; };
  for (let row = 0; row < c.h; row++) for (let col = 0; col < c.w; col++) {
    const i = row * c.w + col;
    const x = col * cw, y = row * chh;
    const bgHex = c.bg[i];
    const bg = rgb(bgHex);
    p.rect(x, y, cw, chh, bg);
    const ch = c.ch[i];
    if (ch === ' ' || ch === '') continue;
    const at = c.at[i];
    const fg = rgb(at & ATTR_DIM ? mix(c.fg[i], bgHex, 0.45) : c.fg[i]);
    if (drawSpecial(p, ch, x, y, cw, chh, fg, bg, scale)) continue;
    let bits = glyphBits(ch);
    // an accented LETTER falls back to its base letter (é → e); never a digit or symbol, whose compatibility form
    // can change meaning (a subscript ₅ is not a 5)
    if (!bits && /^\p{L}$/u.test(ch)) { const base = ch.normalize('NFD').replace(/\p{M}+/gu, ''); if (base && base !== ch) bits = glyphBits(base[0]); }
    if (!bits) {
      // tofu: a hollow box so an unsupported glyph is visible, never silently dropped
      const t = Math.max(1, Math.floor(scale / 2));
      const bx = x + gx + scale, by = y + gy + scale * 2, bw = (FONT_W - 2) * scale, bh = (FONT_H - 4) * scale;
      p.rect(bx, by, bw, t, fg); p.rect(bx, by + bh - t, bw, t, fg); p.rect(bx, by, t, bh, fg); p.rect(bx + bw - t, by, t, bh, fg);
      continue;
    }
    const bold = (at & ATTR_BOLD) !== 0;
    for (let yy = 0; yy < FONT_H; yy++) for (let xx = 0; xx < FONT_W; xx++) {
      if (!bits[yy * FONT_W + xx]) continue;
      p.rect(x + gx + xx * scale, y + gy + yy * scale, scale + (bold ? 1 : 0), scale, fg);
    }
    if (at & ATTR_UNDERLINE) p.rect(x, y + chh - Math.max(1, scale), cw, Math.max(1, Math.floor(scale / 2)), fg);
  }
  // Pixel image slots (coin images) recorded by the canvas in 'pixels' mode: nearest-neighbour into the cell rect.
  for (const s of c.images) {
    const rx = s.x * cw, ry = s.y * chh, rw = s.w * cw, rh = s.h * chh;
    const { w: iw, h: ih, rgba } = s.img;
    if (!iw || !ih) continue;
    for (let yy = 0; yy < rh; yy++) for (let xx = 0; xx < rw; xx++) {
      const sx = Math.min(iw - 1, Math.floor((xx * iw) / rw)), sy = Math.min(ih - 1, Math.floor((yy * ih) / rh));
      const si = (sy * iw + sx) * 4;
      const a = rgba[si + 3] / 255;
      if (a <= 0) continue;
      p.rect(rx + xx, ry + yy, 1, 1, [rgba[si], rgba[si + 1], rgba[si + 2]], a);
    }
  }
  return { w: p.w, h: p.h, rgba: p.rgba };
}
