// @dexterm/tui — pixel helpers for the terminal image renderers (task-1326). Pure, dependency-free
// (the data package owns decoding; this file only needs an RGBA buffer). Compositing over the theme
// background, area-average sampling to a tiny grid, 256-colour quantisation with error diffusion.
import { hexToRgb, rgbToHex, type Hex } from '../color.ts';

/** Straight-alpha RGBA8, row-major — the same shape @dexterm/data's RgbaImage has. */
export interface Pixels { w: number; h: number; rgba: Uint8Array }

export type Rgb = [number, number, number];

/** Area-average the source over a `w × h` grid, compositing alpha over `bg`. Returns packed RGB rows. */
export function sampleGrid(img: Pixels, w: number, h: number, bg: Hex): Float32Array {
  const [br, bgG, bb] = hexToRgb(bg);
  const out = new Float32Array(w * h * 3);
  const xs = img.w / w, ys = img.h / h;
  for (let y = 0; y < h; y++) {
    const y0 = y * ys, y1 = (y + 1) * ys;
    for (let x = 0; x < w; x++) {
      const x0 = x * xs, x1 = (x + 1) * xs;
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let sy = Math.floor(y0); sy < Math.min(img.h, Math.ceil(y1)); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.min(img.w, Math.ceil(x1)); sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          const wgt = wx * wy, o = (sy * img.w + sx) * 4, al = img.rgba[o + 3] / 255;
          r += img.rgba[o] * al * wgt; g += img.rgba[o + 1] * al * wgt; b += img.rgba[o + 2] * al * wgt; a += al * wgt; wsum += wgt;
        }
      }
      const oo = (y * w + x) * 3;
      if (wsum <= 0) { out[oo] = br; out[oo + 1] = bgG; out[oo + 2] = bb; continue; }
      const cov = a / wsum; // coverage 0..1
      const cr = a > 0 ? r / a : 0, cg = a > 0 ? g / a : 0, cb = a > 0 ? b / a : 0;
      out[oo] = cr * cov + br * (1 - cov); out[oo + 1] = cg * cov + bgG * (1 - cov); out[oo + 2] = cb * cov + bb * (1 - cov);
    }
  }
  return out;
}

// xterm-256: 6×6×6 cube (16..231) + 24 greys (232..255). Same tables as color.ts hexToAnsi256.
const CUBE = [0, 95, 135, 175, 215, 255];
const GREYS = Array.from({ length: 24 }, (_, i) => 8 + 10 * i);

/** Nearest xterm-256 colour (as RGB) to an RGB triple: cube or grey, whichever is closer. */
export function nearest256(r: number, g: number, b: number): Rgb {
  const ci = (v: number) => { let best = 0, bd = Infinity; for (let i = 0; i < 6; i++) { const d = Math.abs(CUBE[i] - v); if (d < bd) { bd = d; best = i; } } return CUBE[best]; };
  const cr = ci(r), cg = ci(g), cb = ci(b);
  const cubeD = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2;
  const avg = (r + g + b) / 3;
  let gi = Math.round((avg - 8) / 10); gi = Math.max(0, Math.min(23, gi));
  const gv = GREYS[gi];
  const greyD = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
  return greyD < cubeD ? [gv, gv, gv] : [cr, cg, cb];
}

/**
 * Quantise a sampled grid to the 256-colour palette with Floyd–Steinberg error diffusion. The palette
 * cube is coarse (6 levels), so without diffusion a round logo on a dark panel turns into one flat blob;
 * with it the tone gradients that make a disc read as a disc survive. Error is clamped so a single hot
 * pixel cannot smear across the icon. In place; returns the same array.
 */
export function ditherTo256(grid: Float32Array, w: number, h: number, strength = 0.75): Float32Array {
  const err = new Float32Array((w + 2) * 3 * 2); // two rows of error, 1px padding each side
  const idx = (row: number, x: number) => (row * (w + 2) + x + 1) * 3;
  for (let y = 0; y < h; y++) {
    const cur = y & 1, nxt = cur ^ 1;
    for (let x = -1; x <= w; x++) { const o = idx(nxt, x); err[o] = 0; err[o + 1] = 0; err[o + 2] = 0; }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3, e = idx(cur, x);
      const r = Math.max(0, Math.min(255, grid[o] + err[e])), g = Math.max(0, Math.min(255, grid[o + 1] + err[e + 1])), b = Math.max(0, Math.min(255, grid[o + 2] + err[e + 2]));
      const [qr, qg, qb] = nearest256(r, g, b);
      grid[o] = qr; grid[o + 1] = qg; grid[o + 2] = qb;
      const dr = Math.max(-48, Math.min(48, (r - qr) * strength)), dg = Math.max(-48, Math.min(48, (g - qg) * strength)), db = Math.max(-48, Math.min(48, (b - qb) * strength));
      const spread = (row: number, xx: number, f: number) => { const q = idx(row, xx); err[q] += dr * f; err[q + 1] += dg * f; err[q + 2] += db * f; };
      spread(cur, x + 1, 7 / 16); spread(nxt, x - 1, 3 / 16); spread(nxt, x, 5 / 16); spread(nxt, x + 1, 1 / 16);
    }
  }
  return grid;
}

export function gridHex(grid: Float32Array, i: number): Hex {
  return rgbToHex(Math.round(grid[i * 3]), Math.round(grid[i * 3 + 1]), Math.round(grid[i * 3 + 2]));
}

/** Luma 0..255. */
export function luma(r: number, g: number, b: number): number { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

/**
 * Composite straight-alpha RGBA over an opaque background colour and resample to `w × h` (area average),
 * returning an opaque RGBA buffer — what the pixel protocols (sixel, kitty RGB) and the HTML proof use.
 */
export function flattenTo(img: Pixels, w: number, h: number, bg: Hex): Pixels {
  const grid = sampleGrid(img, w, h, bg);
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = Math.round(grid[i * 3]); rgba[i * 4 + 1] = Math.round(grid[i * 3 + 1]); rgba[i * 4 + 2] = Math.round(grid[i * 3 + 2]); rgba[i * 4 + 3] = 255;
  }
  return { w, h, rgba };
}

/** Area-average resample keeping alpha (for kitty RGBA placements that let the terminal composite). */
export function resampleRgba(img: Pixels, w: number, h: number): Pixels {
  const out = new Uint8Array(w * h * 4);
  const xs = img.w / w, ys = img.h / h;
  for (let y = 0; y < h; y++) {
    const y0 = y * ys, y1 = (y + 1) * ys;
    for (let x = 0; x < w; x++) {
      const x0 = x * xs, x1 = (x + 1) * xs;
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let sy = Math.floor(y0); sy < Math.min(img.h, Math.ceil(y1)); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.min(img.w, Math.ceil(x1)); sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          const wgt = wx * wy, o = (sy * img.w + sx) * 4, al = img.rgba[o + 3] / 255;
          r += img.rgba[o] * al * wgt; g += img.rgba[o + 1] * al * wgt; b += img.rgba[o + 2] * al * wgt; a += al * wgt; wsum += wgt;
        }
      }
      const oo = (y * w + x) * 4;
      if (wsum <= 0 || a <= 0) continue;
      out[oo] = Math.round(r / a); out[oo + 1] = Math.round(g / a); out[oo + 2] = Math.round(b / a); out[oo + 3] = Math.round((a / wsum) * 255);
    }
  }
  return { w, h, rgba: out };
}
