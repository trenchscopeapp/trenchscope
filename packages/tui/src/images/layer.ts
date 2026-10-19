// @dexterm/tui — the pixel-image layer (task-1326). Screens record image SLOTS on the canvas (coinImage in
// coin.ts); after the diff flusher has written the frame, the interactive loop asks this layer what to emit
// so real pixels land exactly over those cells. The layer owns the protocol's lifecycle:
//   kitty  image data is transmitted once per key and placed by id; a placement survives text redraws, so
//          the layer only diffs slots frame to frame (new → place, gone/moved → delete). A screen change or
//          a full repaint deletes every placement first; quit frees everything (`teardown`).
//   iterm / sixel  images are bound to cells and erased by any text written over them, so a slot is
//          re-emitted whenever one of its rows was rewritten (the flusher reports changed rows) or it is new.
// All of it is pure string building over the slot list + the flush result, so it is unit-testable with
// recorded output. The layer never blocks: a slot with no decoded pixels yet simply is not here (the
// screen drew the placeholder cells instead).
import type { Pixels } from './pixels.ts';
import { flattenTo, resampleRgba } from './pixels.ts';
import { cup, kittyTransmit, kittyPlace, kittyDeletePlacement, kittyDeleteAllPlacements, kittyFreeAll, itermInline, sixelEncode } from './protocols.ts';
import type { Hex } from '../color.ts';
import type { ImageProtocol } from './detect.ts';

export interface ImageSlot {
  /** Stable image identity (the service's cache key). */
  key: string;
  x: number; y: number; w: number; h: number;
  img: Pixels;
  /** Our PNG for the image (iTerm2 path); when absent the layer encodes one itself from `img`. */
  png?: Uint8Array | null;
}

export interface ImageLayerOptions {
  /** Cell size in pixels when known (sixel sizing; kitty/iTerm scale to cells themselves). */
  cellPx?: { w: number; h: number } | null;
  /** Surface colour for protocols without alpha (sixel) — the theme background. */
  bg: () => Hex;
  /** PNG encoder for the iTerm2 path (injected from @dexterm/data so the TUI stays dependency-free). */
  encodePng?: (img: Pixels) => Uint8Array;
  /** Pixel budget for the largest image sent over the wire (longest side). */
  maxPx?: number;
}

export interface SyncInput {
  slots: ImageSlot[];
  /** Per-row flag: the flusher rewrote this row. `all` = full repaint. */
  changed: boolean[] | 'all';
  /** A screen key; changing it clears kitty placements. */
  screen: string;
}

interface Placement { key: string; x: number; y: number; w: number; h: number; id: number; pid: number }

export class ImageLayer {
  readonly protocol: Exclude<ImageProtocol, 'blocks'>;
  private readonly opts: ImageLayerOptions;
  private readonly ids = new Map<string, number>();
  private readonly transmitted = new Set<number>();
  private placements: Placement[] = [];
  private drawn = new Map<string, string>(); // iterm/sixel: "x,y" → key
  private nextId = 1000;
  private nextPid = 1;
  private lastScreen: string | null = null;
  /** Counters for the handoff / measurements. */
  readonly stats = { transmits: 0, places: 0, deletes: 0, emits: 0, bytes: 0 };

  constructor(protocol: Exclude<ImageProtocol, 'blocks'>, opts: ImageLayerOptions) {
    this.protocol = protocol;
    this.opts = opts;
  }

  private idFor(key: string): number {
    let id = this.ids.get(key);
    if (id === undefined) { id = this.nextId++; this.ids.set(key, id); }
    return id;
  }

  /** Largest pixel box for a `w × h` cell slot: square-ish, bounded by maxPx. */
  private pixelBox(w: number, h: number): { pw: number; ph: number } {
    const cell = this.opts.cellPx ?? { w: 9, h: 18 };
    const maxPx = this.opts.maxPx ?? 144;
    const bw = w * cell.w, bh = h * cell.h;
    const side = Math.min(bw, bh, maxPx);
    return { pw: Math.max(1, Math.round(side)), ph: Math.max(1, Math.round(side)) };
  }

  /** Bytes to write after a flush. */
  sync(input: SyncInput): string {
    let out = '';
    const slots = dedupe(input.slots);
    if (this.protocol === 'kitty') {
      const full = input.changed === 'all';
      if (this.lastScreen !== null && (input.screen !== this.lastScreen || full)) {
        if (this.placements.length) { out += kittyDeleteAllPlacements(); this.stats.deletes += this.placements.length; }
        this.placements = [];
      }
      this.lastScreen = input.screen;
      const keep: Placement[] = [];
      const want = new Map<string, ImageSlot>();
      for (const s of slots) want.set(`${s.key}@${s.x},${s.y},${s.w},${s.h}`, s);
      for (const p of this.placements) {
        const k = `${p.key}@${p.x},${p.y},${p.w},${p.h}`;
        if (want.has(k)) { keep.push(p); want.delete(k); }
        else { out += kittyDeletePlacement(p.id, p.pid); this.stats.deletes += 1; }
      }
      for (const s of want.values()) {
        const id = this.idFor(s.key);
        if (!this.transmitted.has(id)) {
          const { pw, ph } = this.pixelBox(s.w, s.h);
          const small = s.img.w > pw * 2 || s.img.h > ph * 2 ? resampleRgba(s.img, Math.min(s.img.w, pw * 2), Math.min(s.img.h, ph * 2)) : s.img;
          const t = kittyTransmit(id, small);
          out += t; this.stats.transmits += 1; this.stats.bytes += t.length;
          this.transmitted.add(id);
        }
        const pid = this.nextPid++;
        out += cup(s.y, s.x) + kittyPlace(id, pid, s.w, s.h);
        this.stats.places += 1;
        keep.push({ key: s.key, x: s.x, y: s.y, w: s.w, h: s.h, id, pid });
      }
      this.placements = keep;
      return out;
    }
    // iterm / sixel: cell-bound images
    const changed = input.changed;
    const nextDrawn = new Map<string, string>();
    for (const s of slots) {
      const pos = `${s.x},${s.y}`;
      let rowsChanged = changed === 'all';
      if (!rowsChanged) for (let y = s.y; y < s.y + s.h; y++) if (changed[y]) { rowsChanged = true; break; }
      const isNew = this.drawn.get(pos) !== s.key;
      if (rowsChanged || isNew) {
        const { pw, ph } = this.pixelBox(s.w, s.h);
        let seq: string;
        if (this.protocol === 'iterm') {
          const png = s.png ?? (this.opts.encodePng ? this.opts.encodePng(resampleRgba(s.img, Math.min(s.img.w, pw * 2), Math.min(s.img.h, ph * 2))) : null);
          if (!png) continue;
          seq = itermInline(png, s.w, s.h);
        } else {
          // sixel has no alpha: flatten over the theme bg; height rounded down to a 6-row band multiple
          const sh = Math.max(6, Math.floor(ph / 6) * 6);
          seq = sixelEncode(flattenTo(s.img, pw, sh, this.opts.bg()));
        }
        out += cup(s.y, s.x) + seq;
        this.stats.emits += 1; this.stats.bytes += seq.length;
      }
      nextDrawn.set(pos, s.key);
    }
    this.drawn = nextDrawn;
    return out;
  }

  /** Screen is about to change: forget cell-bound images (their rows will be rewritten). */
  invalidate(): void { this.drawn.clear(); }

  /** Everything off the screen; kitty also frees transmitted data. */
  teardown(): string {
    this.drawn.clear();
    if (this.protocol !== 'kitty') return '';
    const had = this.placements.length > 0 || this.transmitted.size > 0;
    this.placements = []; this.transmitted.clear(); this.ids.clear();
    return had ? kittyFreeAll() : '';
  }
}

function dedupe(slots: ImageSlot[]): ImageSlot[] {
  const seen = new Set<string>();
  const out: ImageSlot[] = [];
  for (const s of slots) {
    if (s.w <= 0 || s.h <= 0) continue;
    const k = `${s.x},${s.y}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(s);
  }
  return out;
}
