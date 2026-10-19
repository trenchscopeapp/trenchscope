// @dexterm/tui — diff flusher (SPEC §7.5). Keeps the last emitted frame and writes only the
// rows that changed, each positioned with an absolute cursor move. A size change or an
// explicit invalidate() forces a full repaint.
import type { Canvas } from './canvas.ts';
import type { ColorDepth } from './color.ts';

export interface FlushResult {
  /** Bytes written to the output (empty when nothing changed). */
  out: string;
  /** Number of rows re-emitted. */
  rows: number;
  /** True when the whole frame was repainted (first frame, resize, invalidate). */
  full: boolean;
  /** task-1326: per-row flag, true for every row this flush rewrote (all true on a full repaint). */
  changed: boolean[];
}

export interface FlusherOpts {
  depth?: ColorDepth;
  /** Hide the cursor while frames are on screen (default true). */
  hideCursor?: boolean;
}

export class Flusher {
  private prev: string[] | null = null;
  private prevW = -1;
  private prevH = -1;
  private dirty = true;
  readonly depth: ColorDepth;
  readonly hideCursor: boolean;

  constructor(opts: FlusherOpts = {}) {
    this.depth = opts.depth ?? 'truecolor';
    this.hideCursor = opts.hideCursor ?? true;
  }

  /** Force the next flush to repaint every row. */
  invalidate(): void { this.dirty = true; }

  /** Compute the delta against the previous frame. Does not write anywhere. */
  diff(c: Canvas): FlushResult {
    const rows: string[] = new Array(c.h);
    for (let y = 0; y < c.h; y++) rows[y] = c.rowAnsi(y, this.depth);
    const full = this.dirty || this.prev === null || this.prevW !== c.w || this.prevH !== c.h;
    let out = '';
    let n = 0;
    const changed: boolean[] = new Array(c.h).fill(false);
    if (full) {
      out += '\x1b[H';
      if (this.prev !== null && (this.prevW !== c.w || this.prevH !== c.h)) out += '\x1b[2J';
      for (let y = 0; y < c.h; y++) {
        out += `\x1b[${y + 1};1H` + rows[y];
        changed[y] = true;
        n++;
      }
    } else {
      const prev = this.prev as string[];
      for (let y = 0; y < c.h; y++) {
        if (rows[y] === prev[y]) continue;
        out += `\x1b[${y + 1};1H` + rows[y];
        changed[y] = true;
        n++;
      }
    }
    if (out && this.hideCursor) out = '\x1b[?25l' + out;
    this.prev = rows;
    this.prevW = c.w;
    this.prevH = c.h;
    this.dirty = false;
    return { out, rows: n, full, changed };
  }

  /** Diff and write to `write` (e.g. process.stdout.write). Returns the result for callers that count rows. */
  flush(c: Canvas, write: (s: string) => unknown): FlushResult {
    const r = this.diff(c);
    if (r.out) write(r.out);
    return r;
  }
}

/** Enter the alternate screen, clear it, hide the cursor. */
export const ENTER_SCREEN = '\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l';
/** Reset attributes, show the cursor, leave the alternate screen. */
export const LEAVE_SCREEN = '\x1b[0m\x1b[?25h\x1b[?1049l';
