// trenchscope — coin images on the screens (task-1326): the thin glue between a screen's cell box and the
// ImageService + the TUI's coinImage(). Everything here is synchronous: the service answers from memory
// (and queues what it does not have), the TUI draws pixels-slot / block art / placeholder accordingly.
import { coinImage, type Canvas, type Hex, type BlockMode } from '@dexterm/tui';
import type { AppState } from '../state.ts';

export interface CoinBox {
  x: number; y: number; w: number; h: number;
  /** Source URL (ScreenerRow.image / TokenView.image / NewPairRow.image); null → placeholder. */
  url: string | null | undefined;
  symbol: string;
  bg: Hex;
  /** Queue priority when the image is not loaded yet: 2 = the open token, 1 = a visible row. */
  prio?: number;
  mode?: BlockMode;
}

/**
 * True when this run shows coin images at all: live/replay with the service on. Never on fixtures — fixture rows
 * carry no image URL, so the column would only ever paint placeholder initials, and the fixture frames (goldens,
 * `--fixtures` one-shots) must stay byte for byte what they were before images existed.
 */
export function imagesOn(state: AppState): boolean { return !!state.images && state.screener.source !== 'fixtures'; }

/** Draw a coin image box (or its placeholder) if images are on; returns true when something was drawn. */
export function drawCoin(c: Canvas, state: AppState, b: CoinBox): boolean {
  const svc = state.images;
  if (!svc || b.w <= 0 || b.h <= 0) return false;
  const st = svc.get(b.url ?? null, b.prio ?? 1);
  const ready = st.state === 'ready';
  coinImage(c, {
    x: b.x, y: b.y, w: b.w, h: b.h, symbol: b.symbol,
    img: ready ? st.img : null, png: ready ? st.png : null, key: ready ? st.key : null,
    pending: st.state === 'pending',
    depth: state.colorDepth, bg: b.bg, mode: b.mode ?? state.imageBlocks ?? 'half',
  });
  return true;
}

/** The popup's same-origin image path for a coin, when the thumbnail is already cached. */
export function popupImagePath(state: AppState, url: string | null | undefined): string | null {
  const svc = state.images;
  if (!svc || !url) return null;
  const st = svc.get(url, 2);
  return st.state === 'ready' ? `/img/${st.key}.png` : null;
}
