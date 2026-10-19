// @dexterm/tui — the three inline-image wire formats (task-1326), as pure string builders so recorded
// terminal output can be asserted byte for byte.
//   kitty  APC `ESC_G … ESC\`: transmit RGBA once per image id (f=32, chunked, q=2 = never reply), then
//          place by id with c/r cells and C=1 (cursor stays put); placements are deleted by (i, p).
//   iterm  OSC 1337 `File=inline=1;width=<cells>;height=<rows>;preserveAspectRatio=1:<base64 png> BEL`.
//   sixel  DCS `ESC P 0;1 q "1;1;w;h #palette… data ESC\`, ≤256 colours, 6-row bands, run-length encoded.
import type { Pixels } from './pixels.ts';

const ESC = '\x1b';
export const KITTY_CHUNK = 4096;

/** `CSI row;col H` (1-based). */
export function cup(row: number, col: number): string { return `${ESC}[${row + 1};${col + 1}H`; }

// ---------------------------------------------------------------------------------------------- kitty
/** Transmit straight-alpha RGBA as image `id` (no placement). Chunked at 4096 base64 bytes per APC. */
export function kittyTransmit(id: number, img: Pixels): string {
  const b64 = Buffer.from(img.rgba.buffer, img.rgba.byteOffset, img.rgba.byteLength).toString('base64');
  let out = '';
  for (let i = 0; i < b64.length; i += KITTY_CHUNK) {
    const chunk = b64.slice(i, i + KITTY_CHUNK);
    const more = i + KITTY_CHUNK < b64.length ? 1 : 0;
    const ctl = i === 0 ? `a=t,f=32,s=${img.w},v=${img.h},i=${id},q=2,m=${more}` : `m=${more}`;
    out += `${ESC}_G${ctl};${chunk}${ESC}\\`;
  }
  return out;
}

/** Place image `id` as placement `pid` over `cols × rows` cells at the cursor, cursor unmoved. */
export function kittyPlace(id: number, pid: number, cols: number, rows: number): string {
  return `${ESC}_Ga=p,i=${id},p=${pid},c=${cols},r=${rows},C=1,q=2${ESC}\\`;
}

export function kittyDeletePlacement(id: number, pid: number): string { return `${ESC}_Ga=d,d=i,i=${id},p=${pid},q=2${ESC}\\`; }
/** Delete every visible placement, keep the transmitted data (screen change). */
export function kittyDeleteAllPlacements(): string { return `${ESC}_Ga=d,d=a,q=2${ESC}\\`; }
/** Delete every placement AND free the image data (quit). */
export function kittyFreeAll(): string { return `${ESC}_Ga=d,d=A,q=2${ESC}\\`; }

// ---------------------------------------------------------------------------------------------- iTerm2
export function itermInline(png: Uint8Array, cols: number, rows: number): string {
  const b64 = Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString('base64');
  return `${ESC}]1337;File=inline=1;size=${png.byteLength};width=${cols};height=${rows};preserveAspectRatio=1;doNotMoveCursor=1:${b64}\x07`;
}

// ---------------------------------------------------------------------------------------------- sixel
/** Opaque pixels → a ≤ 252-colour sixel image (6×7×6 uniform levels; plenty for a thumbnail). */
export function sixelEncode(img: Pixels): string {
  const { w, h, rgba } = img;
  if (w <= 0 || h <= 0) return '';
  const RL = 6, GL = 7, BL = 6;
  const q = (v: number, levels: number) => Math.min(levels - 1, Math.round((v / 255) * (levels - 1)));
  const idx = new Uint16Array(w * h);
  const used = new Set<number>();
  for (let i = 0; i < w * h; i++) {
    const r = q(rgba[i * 4], RL), g = q(rgba[i * 4 + 1], GL), b = q(rgba[i * 4 + 2], BL);
    const k = (r * GL + g) * BL + b;
    idx[i] = k; used.add(k);
  }
  let out = `${ESC}P0;1q"1;1;${w};${h}`;
  for (const k of used) {
    const b = k % BL, g = Math.floor(k / BL) % GL, r = Math.floor(k / (BL * GL));
    const pc = (v: number, levels: number) => Math.round((v / (levels - 1)) * 100);
    out += `#${k};2;${pc(r, RL)};${pc(g, GL)};${pc(b, BL)}`;
  }
  for (let band = 0; band < h; band += 6) {
    const rows = Math.min(6, h - band);
    const bandColors = new Set<number>();
    for (let y = band; y < band + rows; y++) for (let x = 0; x < w; x++) bandColors.add(idx[y * w + x]);
    let first = true;
    for (const k of bandColors) {
      if (!first) out += '$';
      first = false;
      out += `#${k}`;
      let run = 0, last = -1;
      const flush = () => { if (run <= 0) return; const ch = String.fromCharCode(63 + last); out += run > 3 ? `!${run}${ch}` : ch.repeat(run); run = 0; };
      for (let x = 0; x < w; x++) {
        let bits = 0;
        for (let r = 0; r < rows; r++) if (idx[(band + r) * w + x] === k) bits |= 1 << r;
        if (bits === last) run += 1; else { flush(); last = bits; run = 1; }
      }
      flush();
    }
    out += '-';
  }
  return out + `${ESC}\\`;
}
