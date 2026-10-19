// @dexterm/tui — coin images as cells (task-1326): the fallback for every terminal without an inline-image
// protocol (Apple Terminal.app above all), plus the placeholder every terminal draws while an image is
// loading or when there is none.
//
//   half  one cell = 1 px wide × 2 px tall: `▀` with fg = top pixel, bg = bottom pixel. Exact two colours
//         per cell, square pixels (a cell is ~1:2), so a w×h cell box samples the logo at w × 2h.
//   quad  one cell = 2 × 2 px via the quadrant blocks (▘▝▀▖▌▞▛▗▚▐▜▄▙▟█): four samples but only two
//         colours per cell (bright/dark split by luma). Twice the detail of `half`, used for the one-row
//         icons next to list rows (a 2-cell icon becomes 4 × 2 samples instead of 2 × 2).
//
// On a 256-colour terminal the sample grid is Floyd–Steinberg dithered into the xterm cube before it
// becomes cells (pixels.ts), tuned so a round logo keeps its disc. Cells are written `hard` so no effect
// (rain, datamosh, aberration) can ever overdraw an icon, and the rect is excluded from rain zones.
import type { Canvas } from '../canvas.ts';
import { rgbToHex, hexToRgb, type ColorDepth, type Hex } from '../color.ts';
import { sampleGrid, ditherTo256, gridHex, luma, nearest256, type Pixels } from './pixels.ts';

export type BlockMode = 'half' | 'quad';

export interface BlockArtOpts {
  mode?: BlockMode;
  depth: ColorDepth;
  /** The surface the icon sits on: transparent pixels composite over it. */
  bg: Hex;
  /** Error-diffusion dithering at 256 colours (default on). */
  dither?: boolean;
  /** Stable identity of `img` (the service's cache key): lets the sampled grid be memoised across frames. */
  cacheKey?: string | null;
}

// Sampled (and dithered) grids per image × box × surface × depth: the sampler reads every thumbnail pixel
// (96² for a 2-cell icon), which is the whole cost of block art; a screenful of rows re-asks for the same
// grids 30 times a second. Bounded LRU; a theme change or a new size is just a different key.
const GRIDS = new Map<string, Float32Array>();
const GRID_CAP = 1024;
function gridFor(img: Pixels, gw: number, gh: number, opts: BlockArtOpts): Float32Array {
  const key = opts.cacheKey ? `${opts.cacheKey}|${gw}x${gh}|${opts.bg}|${opts.depth}|${opts.dither === false ? 'n' : 'd'}` : null;
  if (key) { const hit = GRIDS.get(key); if (hit) { GRIDS.delete(key); GRIDS.set(key, hit); return hit; } }
  const grid = sampleGrid(img, gw, gh, opts.bg);
  if (opts.depth === '256' && opts.dither !== false) ditherTo256(grid, gw, gh);
  else if (opts.depth === '256') for (let i = 0; i < gw * gh; i++) { const [r, g, b] = nearest256(grid[i * 3], grid[i * 3 + 1], grid[i * 3 + 2]); grid[i * 3] = r; grid[i * 3 + 1] = g; grid[i * 3 + 2] = b; }
  if (key) { GRIDS.set(key, grid); if (GRIDS.size > GRID_CAP) GRIDS.delete(GRIDS.keys().next().value as string); }
  return grid;
}

// bit 8 = top-left, 4 = top-right, 2 = bottom-left, 1 = bottom-right set to the FOREGROUND colour
const QUAD = [' ', '▗', '▖', '▄', '▝', '▐', '▞', '▟', '▘', '▚', '▌', '▙', '▀', '▜', '▛', '█'];

/** Draw `img` into the `w × h` cell box at (x, y). Pure cell writes; never throws on an odd box. */
export function drawBlockArt(c: Canvas, x: number, y: number, w: number, h: number, img: Pixels, opts: BlockArtOpts): void {
  if (w <= 0 || h <= 0 || img.w <= 0 || img.h <= 0) return;
  const mode = opts.mode ?? 'half';
  const gw = mode === 'half' ? w : w * 2, gh = h * 2;
  const grid = gridFor(img, gw, gh, opts);
  c.noRain(x, y, w, h);
  if (mode === 'half') {
    for (let cy = 0; cy < h; cy++) {
      for (let cx = 0; cx < w; cx++) {
        const top = gridHex(grid, (cy * 2) * gw + cx), bot = gridHex(grid, (cy * 2 + 1) * gw + cx);
        c.put(x + cx, y + cy, '▀', { fg: top, bg: bot, hard: true });
      }
    }
    return;
  }
  // quad: cluster the four samples of a cell into two colours by luma, pick the matching glyph
  const px = (gx: number, gy: number): [number, number, number] => { const i = (gy * gw + gx) * 3; return [grid[i], grid[i + 1], grid[i + 2]]; };
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const s = [px(cx * 2, cy * 2), px(cx * 2 + 1, cy * 2), px(cx * 2, cy * 2 + 1), px(cx * 2 + 1, cy * 2 + 1)];
      const l = s.map((p) => luma(p[0], p[1], p[2]));
      const lo = Math.min(...l), hi = Math.max(...l);
      if (hi - lo < 6) {
        // flat cell: one colour, full block (keeps the exact average instead of a 2-colour split)
        const avg = s.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4, a[2] + p[2] / 4], [0, 0, 0]);
        const col = quantHex(avg[0], avg[1], avg[2], opts.depth);
        c.put(x + cx, y + cy, '█', { fg: col, bg: col, hard: true });
        continue;
      }
      const mid = (lo + hi) / 2;
      let bits = 0;
      const fgS: number[][] = [], bgS: number[][] = [];
      for (let k = 0; k < 4; k++) { if (l[k] >= mid) { bits |= 8 >> k; fgS.push(s[k]); } else bgS.push(s[k]); }
      const mean = (xs: number[][]): [number, number, number] => [xs.reduce((a, p) => a + p[0], 0) / xs.length, xs.reduce((a, p) => a + p[1], 0) / xs.length, xs.reduce((a, p) => a + p[2], 0) / xs.length];
      const fgC = mean(fgS), bgC = mean(bgS);
      c.put(x + cx, y + cy, QUAD[bits], { fg: quantHex(fgC[0], fgC[1], fgC[2], opts.depth), bg: quantHex(bgC[0], bgC[1], bgC[2], opts.depth), hard: true });
    }
  }
}

function quantHex(r: number, g: number, b: number, depth: ColorDepth): Hex {
  if (depth === '256') { const [qr, qg, qb] = nearest256(r, g, b); return rgbToHex(qr, qg, qb); }
  return rgbToHex(Math.round(r), Math.round(g), Math.round(b));
}

// ---------------------------------------------------------------------------------------------- placeholder
/** FNV-1a over the symbol → a stable hue; saturated but not neon so numbers beside it stay readable. */
export function placeholderColor(symbol: string, depth: ColorDepth = 'truecolor'): Hex {
  let h = 0x811c9dc5;
  for (const ch of symbol.toUpperCase()) { h ^= ch.codePointAt(0) as number; h = Math.imul(h, 0x01000193) >>> 0; }
  const hue = (h % 360) / 360;
  const [r, g, b] = hslToRgb(hue, 0.62, 0.42);
  if (depth === '256') { const [qr, qg, qb] = nearest256(r, g, b); return rgbToHex(qr, qg, qb); }
  return rgbToHex(r, g, b);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number): number => { t = (t + 1) % 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
}

/** The letter a placeholder shows: the first letter/digit of the ticker, else `?`. */
export function placeholderInitial(symbol: string): string {
  const m = /[A-Za-z0-9]/.exec(symbol);
  return m ? m[0].toUpperCase() : '?';
}

export interface PlaceholderOpts { depth: ColorDepth; bg: Hex; /** `pending` draws the same disc with a dim letter. */ pending?: boolean }

/** Ticker initial on a hashed colour disc, sized to the box. Never an error glyph. */
export function drawPlaceholder(c: Canvas, x: number, y: number, w: number, h: number, symbol: string, opts: PlaceholderOpts): void {
  if (w <= 0 || h <= 0) return;
  const col = placeholderColor(symbol, opts.depth);
  const [r, g, b] = hexToRgb(col);
  const ink = luma(r, g, b) > 140 ? '#000000' : '#ffffff';
  c.noRain(x, y, w, h);
  // a rounded look: at 2+ rows, soften the four corner cells with half blocks toward the surface
  for (let cy = 0; cy < h; cy++) for (let cx = 0; cx < w; cx++) c.put(x + cx, y + cy, ' ', { fg: ink, bg: col, hard: true });
  if (h >= 2 && w >= 4) {
    c.put(x, y, '▗', { fg: col, bg: opts.bg, hard: true });
    c.put(x + w - 1, y, '▖', { fg: col, bg: opts.bg, hard: true });
    c.put(x, y + h - 1, '▝', { fg: col, bg: opts.bg, hard: true });
    c.put(x + w - 1, y + h - 1, '▘', { fg: col, bg: opts.bg, hard: true });
  }
  const letter = placeholderInitial(symbol);
  c.put(x + Math.floor((w - 1) / 2), y + Math.floor((h - 1) / 2), letter, { fg: ink, bg: col, b: true, d: !!opts.pending, hard: true });
}
