// @dexterm/data — GIF first-frame decoder (task-1326). GIF87a/89a, global or local palette, interlace,
// Graphic Control Extension transparency. Only the FIRST image block is decoded (an animated logo shows
// its first frame); every other block is skipped by its own length fields. LZW is bounds-checked: a code
// stream that references an undefined code stops the frame instead of reading out of range.
import type { RgbaImage, DecodeLimits } from './types.ts';
import { DEFAULT_LIMITS, ImageDecodeError, checkDims } from './types.ts';

function readSubBlocks(b: Uint8Array, pos: number, cap: number): { data: Uint8Array; next: number } {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    if (pos >= b.length) throw new ImageDecodeError('gif: truncated sub-blocks');
    const n = b[pos];
    pos += 1;
    if (n === 0) break;
    if (pos + n > b.length) throw new ImageDecodeError('gif: truncated sub-block');
    parts.push(b.subarray(pos, pos + n));
    total += n;
    if (total > cap) throw new ImageDecodeError('gif: data over the byte cap');
    pos += n;
  }
  const data = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { data.set(p, o); o += p.length; }
  return { data, next: pos };
}

/** LZW decode `data` into `npix` palette indices. */
function lzw(data: Uint8Array, minCodeSize: number, npix: number): Uint8Array {
  if (minCodeSize < 2 || minCodeSize > 11) throw new ImageDecodeError('gif: bad LZW code size');
  const out = new Uint8Array(npix);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const MAX = 4096;
  const prefix = new Int32Array(MAX);
  const suffix = new Uint8Array(MAX);
  const lengths = new Uint16Array(MAX);
  for (let i = 0; i < clear; i++) { prefix[i] = -1; suffix[i] = i; lengths[i] = 1; }
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let prev = -1;
  let bitBuf = 0, bitCnt = 0, pos = 0, op = 0;
  const stack = new Uint8Array(MAX + 1);
  while (op < npix) {
    while (bitCnt < codeSize) {
      if (pos >= data.length) return out; // stream ended early: keep what we have
      bitBuf |= data[pos++] << bitCnt;
      bitCnt += 8;
    }
    const code = bitBuf & ((1 << codeSize) - 1);
    bitBuf >>>= codeSize; bitCnt -= codeSize;
    if (code === clear) { codeSize = minCodeSize + 1; next = eoi + 1; prev = -1; continue; }
    if (code === eoi) break;
    let cur = code;
    let first: number;
    if (code < next) {
      // known code: emit its string
      let n = lengths[code];
      let c = code;
      for (let i = n - 1; i >= 0; i--) { stack[i] = suffix[c]; c = prefix[c]; }
      first = stack[0];
      for (let i = 0; i < n && op < npix; i++) out[op++] = stack[i];
    } else if (code === next && prev >= 0) {
      // KwKwK case: prev string + its first char
      const n = lengths[prev];
      let c = prev;
      for (let i = n - 1; i >= 0; i--) { stack[i] = suffix[c]; c = prefix[c]; }
      stack[n] = stack[0];
      first = stack[0];
      for (let i = 0; i <= n && op < npix; i++) out[op++] = stack[i];
    } else {
      throw new ImageDecodeError('gif: corrupt LZW stream');
    }
    if (prev >= 0 && next < MAX) {
      prefix[next] = prev; suffix[next] = first; lengths[next] = lengths[prev] + 1;
      next += 1;
      if (next === (1 << codeSize) && codeSize < 12) codeSize += 1;
    }
    prev = cur;
  }
  return out;
}

export function decodeGif(b: Uint8Array, limits: DecodeLimits = DEFAULT_LIMITS): RgbaImage {
  if (b.length < 13 || String.fromCharCode(b[0], b[1], b[2]) !== 'GIF') throw new ImageDecodeError('gif: bad signature');
  const w = b[6] | (b[7] << 8), h = b[8] | (b[9] << 8);
  checkDims(w, h, limits, 'gif');
  const flags = b[10];
  const bgIndex = b[11];
  let pos = 13;
  let gct: Uint8Array | null = null;
  if (flags & 0x80) {
    const n = 3 * (1 << ((flags & 7) + 1));
    if (pos + n > b.length) throw new ImageDecodeError('gif: truncated palette');
    gct = b.subarray(pos, pos + n);
    pos += n;
  }
  let transparent = -1;
  const out = new Uint8Array(w * h * 4); // transparent canvas
  void bgIndex;
  while (pos < b.length) {
    const tag = b[pos];
    if (tag === 0x3b) break; // trailer
    if (tag === 0x21) { // extension
      const label = b[pos + 1];
      pos += 2;
      if (label === 0xf9) { // GCE: size, flags, delay(2), transparent index, 0
        const size = b[pos];
        if (size >= 4 && pos + 5 < b.length) { if (b[pos + 1] & 1) transparent = b[pos + 4]; }
        pos += 1 + size;
        if (b[pos] !== 0) { pos = readSubBlocks(b, pos, limits.maxBytes).next; } else pos += 1;
      } else {
        pos = readSubBlocks(b, pos, limits.maxBytes).next;
      }
      continue;
    }
    if (tag === 0x2c) { // image descriptor
      if (pos + 10 > b.length) throw new ImageDecodeError('gif: truncated image descriptor');
      const left = b[pos + 1] | (b[pos + 2] << 8), top = b[pos + 3] | (b[pos + 4] << 8);
      const iw = b[pos + 5] | (b[pos + 6] << 8), ih = b[pos + 7] | (b[pos + 8] << 8);
      const iflags = b[pos + 9];
      pos += 10;
      checkDims(iw, ih, limits, 'gif frame');
      let pal = gct;
      if (iflags & 0x80) {
        const n = 3 * (1 << ((iflags & 7) + 1));
        if (pos + n > b.length) throw new ImageDecodeError('gif: truncated local palette');
        pal = b.subarray(pos, pos + n);
        pos += n;
      }
      if (!pal) throw new ImageDecodeError('gif: no palette');
      const minCode = b[pos];
      pos += 1;
      const { data, next } = readSubBlocks(b, pos, limits.maxBytes);
      pos = next;
      const idx = lzw(data, minCode, iw * ih);
      const interlaced = (iflags & 0x40) !== 0;
      const rowOrder: number[] = [];
      if (interlaced) {
        for (let y = 0; y < ih; y += 8) rowOrder.push(y);
        for (let y = 4; y < ih; y += 8) rowOrder.push(y);
        for (let y = 2; y < ih; y += 4) rowOrder.push(y);
        for (let y = 1; y < ih; y += 2) rowOrder.push(y);
      }
      for (let r = 0; r < ih; r++) {
        const y = interlaced ? rowOrder[r] : r;
        const dy = top + y;
        if (dy < 0 || dy >= h) continue;
        for (let x = 0; x < iw; x++) {
          const dx = left + x;
          if (dx < 0 || dx >= w) continue;
          const ci = idx[r * iw + x];
          if (ci === transparent) continue;
          if (ci * 3 + 2 >= pal.length) continue; // out-of-palette index: leave transparent
          const o = (dy * w + dx) * 4;
          out[o] = pal[ci * 3]; out[o + 1] = pal[ci * 3 + 1]; out[o + 2] = pal[ci * 3 + 2]; out[o + 3] = 255;
        }
      }
      return { w, h, rgba: out }; // first frame only
    }
    throw new ImageDecodeError(`gif: unknown block 0x${tag.toString(16)}`);
  }
  throw new ImageDecodeError('gif: no image data');
}
