// @dexterm/tui — `coinImage()`: the one call a screen makes to show a coin's picture in a cell box
// (task-1326). It never fetches and never waits: the caller hands it whatever the ImageService has right
// now. Pixel-capable canvases (c.imageMode === 'pixels') get blank hard cells plus a recorded slot the
// ImageLayer paints after the flush; everyone else gets block art; no pixels yet → the ticker placeholder.
import type { Canvas } from '../canvas.ts';
import type { ColorDepth, Hex } from '../color.ts';
import type { Pixels } from './pixels.ts';
import { drawBlockArt, drawPlaceholder, type BlockMode } from './blocks.ts';

export interface CoinImageSpec {
  x: number; y: number; w: number; h: number;
  symbol: string;
  /** Decoded thumbnail, or null (pending / missing / no URL). */
  img: Pixels | null;
  /** Our PNG for the thumbnail (iTerm2 path), when the service has it. */
  png?: Uint8Array | null;
  /** Stable image key (the service's cache key); required for a pixel slot. */
  key?: string | null;
  /** True while the service is still fetching: the placeholder letter dims. */
  pending?: boolean;
  depth: ColorDepth;
  bg: Hex;
  mode?: BlockMode;
}

/** How the canvas shows images: `cells` (block art / placeholder) or `pixels` (slots for an ImageLayer). */
export type ImageMode = 'cells' | 'pixels';

export function coinImage(c: Canvas, s: CoinImageSpec): void {
  if (s.w <= 0 || s.h <= 0) return;
  if (s.img && c.imageMode === 'pixels' && s.key) {
    for (let cy = 0; cy < s.h; cy++) for (let cx = 0; cx < s.w; cx++) c.put(s.x + cx, s.y + cy, ' ', { fg: s.bg, bg: s.bg, hard: true });
    c.noRain(s.x, s.y, s.w, s.h);
    c.images.push({ key: s.key, x: s.x, y: s.y, w: s.w, h: s.h, img: s.img, png: s.png ?? null });
    return;
  }
  if (s.img) { drawBlockArt(c, s.x, s.y, s.w, s.h, s.img, { mode: s.mode, depth: s.depth, bg: s.bg, cacheKey: s.key ?? null }); return; }
  drawPlaceholder(c, s.x, s.y, s.w, s.h, s.symbol, { depth: s.depth, bg: s.bg, pending: s.pending });
}

/** Cell boxes the screens use: a one-row list icon and the token-header hero. */
export const COIN_ICON_W = 2;
export const COIN_HERO_W = 8;
export const COIN_HERO_H = 4;
