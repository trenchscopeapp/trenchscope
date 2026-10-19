// @dexterm/data — PNG decoder + encoder (task-1326, coin images). Pure TypeScript on node:zlib, no native
// code and no third-party decoder: an untrusted coin logo is parsed by bounds-checked JS and can never run
// anything. Decodes every PNG colour type (grey, RGB, palette, grey+alpha, RGBA) at bit depths 1/2/4/8/16,
// with tRNS transparency and Adam7 interlace, into straight-alpha RGBA8. Dimension and pixel caps are
// enforced BEFORE any pixel buffer is allocated. Ancillary chunks (APNG, iCCP, gAMA, …) are ignored.
import { inflateSync, deflateSync } from 'node:zlib';
import type { RgbaImage, DecodeLimits } from './types.ts';
import { DEFAULT_LIMITS, ImageDecodeError, checkDims } from './types.ts';

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(b: Uint8Array): boolean {
  if (b.length < 8) return false;
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) return false;
  return true;
}

interface Header { w: number; h: number; depth: number; colorType: number; interlace: number }

function channelsOf(colorType: number): number {
  switch (colorType) {
    case 0: return 1; // grey
    case 2: return 3; // rgb
    case 3: return 1; // palette index
    case 4: return 2; // grey + alpha
    case 6: return 4; // rgba
    default: throw new ImageDecodeError(`png: unknown colour type ${colorType}`);
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Undo the per-scanline filter in place over `rows` scanlines of `stride` bytes (plus a filter byte each). */
function unfilter(data: Uint8Array, off: number, rows: number, stride: number, bpp: number): Uint8Array {
  const out = new Uint8Array(rows * stride);
  let prevRow: Uint8Array | null = null;
  for (let y = 0; y < rows; y++) {
    const ft = data[off];
    off += 1;
    const row = out.subarray(y * stride, (y + 1) * stride);
    row.set(data.subarray(off, off + stride));
    off += stride;
    switch (ft) {
      case 0: break;
      case 1: for (let i = bpp; i < stride; i++) row[i] = (row[i] + row[i - bpp]) & 0xff; break;
      case 2: if (prevRow) for (let i = 0; i < stride; i++) row[i] = (row[i] + prevRow[i]) & 0xff; break;
      case 3:
        for (let i = 0; i < stride; i++) {
          const left = i >= bpp ? row[i - bpp] : 0;
          const up = prevRow ? prevRow[i] : 0;
          row[i] = (row[i] + ((left + up) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const left = i >= bpp ? row[i - bpp] : 0;
          const up = prevRow ? prevRow[i] : 0;
          const ul = prevRow && i >= bpp ? prevRow[i - bpp] : 0;
          row[i] = (row[i] + paeth(left, up, ul)) & 0xff;
        }
        break;
      default: throw new ImageDecodeError(`png: bad filter type ${ft}`);
    }
    prevRow = row;
  }
  return out;
}

/** Read sample `i` (0-based, across the row) of `depth` bits from a packed scanline, scaled to 0..255. */
function sampleAt(row: Uint8Array, i: number, depth: number): number {
  if (depth === 8) return row[i];
  if (depth === 16) return row[i * 2]; // high byte: 16-bit → 8-bit
  const perByte = 8 / depth;
  const byte = row[Math.floor(i / perByte)];
  const shift = 8 - depth * ((i % perByte) + 1);
  const v = (byte >> shift) & ((1 << depth) - 1);
  return depth === 1 ? v * 255 : depth === 2 ? v * 85 : v * 17;
}

/** Raw sample value (unscaled) for palette indices. */
function indexAt(row: Uint8Array, i: number, depth: number): number {
  if (depth === 8) return row[i];
  const perByte = 8 / depth;
  const byte = row[Math.floor(i / perByte)];
  const shift = 8 - depth * ((i % perByte) + 1);
  return (byte >> shift) & ((1 << depth) - 1);
}

// Adam7: x start, y start, x step, y step
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;

export function decodePng(bytes: Uint8Array, limits: DecodeLimits = DEFAULT_LIMITS): RgbaImage {
  if (!isPng(bytes)) throw new ImageDecodeError('png: bad signature');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let hdr: Header | null = null;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let idatLen = 0;
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const dataOff = pos + 8;
    if (len > bytes.length - dataOff) throw new ImageDecodeError(`png: chunk ${type} overruns the file`);
    if (type === 'IHDR') {
      if (len < 13) throw new ImageDecodeError('png: short IHDR');
      hdr = { w: dv.getUint32(dataOff), h: dv.getUint32(dataOff + 4), depth: bytes[dataOff + 8], colorType: bytes[dataOff + 9], interlace: bytes[dataOff + 12] };
      if (bytes[dataOff + 10] !== 0 || bytes[dataOff + 11] !== 0) throw new ImageDecodeError('png: unsupported compression/filter method');
      if (![1, 2, 4, 8, 16].includes(hdr.depth)) throw new ImageDecodeError(`png: bad bit depth ${hdr.depth}`);
      if (hdr.interlace !== 0 && hdr.interlace !== 1) throw new ImageDecodeError('png: bad interlace method');
      checkDims(hdr.w, hdr.h, limits, 'png');
    } else if (type === 'PLTE') {
      palette = bytes.subarray(dataOff, dataOff + len);
    } else if (type === 'tRNS') {
      trns = bytes.subarray(dataOff, dataOff + len);
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(dataOff, dataOff + len));
      idatLen += len;
      if (idatLen > limits.maxBytes) throw new ImageDecodeError('png: compressed data over the byte cap');
    } else if (type === 'IEND') {
      break;
    }
    pos = dataOff + len + 4; // skip CRC (not verified: a corrupt chunk fails decoding anyway)
  }
  if (!hdr) throw new ImageDecodeError('png: no IHDR');
  if (!idat.length) throw new ImageDecodeError('png: no IDAT');
  const { w, h, depth, colorType, interlace } = hdr;
  const ch = channelsOf(colorType);
  if (colorType === 3 && !palette) throw new ImageDecodeError('png: palette image without PLTE');
  if ((colorType === 2 || colorType === 4 || colorType === 6) && depth < 8) throw new ImageDecodeError('png: bad depth for colour type');
  const bitsPerPx = ch * depth;
  const bpp = Math.max(1, Math.ceil(bitsPerPx / 8));
  const strideFor = (cols: number) => Math.ceil((cols * bitsPerPx) / 8);
  // Expected raw size (bounded by the dimension caps checked above).
  let expect = 0;
  if (interlace) {
    for (const [sx, sy, dx, dy] of ADAM7) {
      const pw = Math.ceil((w - sx) / dx), ph = Math.ceil((h - sy) / dy);
      if (pw > 0 && ph > 0) expect += ph * (strideFor(pw) + 1);
    }
  } else expect = h * (strideFor(w) + 1);
  const raw = inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c)), idatLen), { maxOutputLength: expect });
  if (raw.length < expect) throw new ImageDecodeError('png: truncated image data');

  const out = new Uint8Array(w * h * 4);
  const writePixel = (x: number, y: number, row: Uint8Array, i: number): void => {
    const o = (y * w + x) * 4;
    switch (colorType) {
      case 0: {
        const g = sampleAt(row, i, depth);
        out[o] = g; out[o + 1] = g; out[o + 2] = g;
        let a = 255;
        if (trns && trns.length >= 2) {
          const key = (trns[0] << 8) | trns[1];
          const rawV = depth === 16 ? ((row[i * 2] << 8) | row[i * 2 + 1]) : indexAt(row, i, depth);
          if (rawV === key) a = 0;
        }
        out[o + 3] = a;
        break;
      }
      case 2: {
        const s = depth === 16 ? 2 : 1;
        const r = row[i * 3 * s], g = row[(i * 3 + 1) * s], b = row[(i * 3 + 2) * s];
        out[o] = r; out[o + 1] = g; out[o + 2] = b;
        let a = 255;
        if (trns && trns.length >= 6) {
          const kr = (trns[0] << 8) | trns[1], kg = (trns[2] << 8) | trns[3], kb = (trns[4] << 8) | trns[5];
          const rr = depth === 16 ? ((row[i * 6] << 8) | row[i * 6 + 1]) : r;
          const gg = depth === 16 ? ((row[i * 6 + 2] << 8) | row[i * 6 + 3]) : g;
          const bb = depth === 16 ? ((row[i * 6 + 4] << 8) | row[i * 6 + 5]) : b;
          if (rr === kr && gg === kg && bb === kb) a = 0;
        }
        out[o + 3] = a;
        break;
      }
      case 3: {
        const idx = indexAt(row, i, depth);
        const p = palette as Uint8Array;
        if (idx * 3 + 2 >= p.length) throw new ImageDecodeError('png: palette index out of range');
        out[o] = p[idx * 3]; out[o + 1] = p[idx * 3 + 1]; out[o + 2] = p[idx * 3 + 2];
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
        break;
      }
      case 4: {
        const s = depth === 16 ? 2 : 1;
        const g = row[i * 2 * s], a = row[(i * 2 + 1) * s];
        out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = a;
        break;
      }
      case 6: {
        const s = depth === 16 ? 2 : 1;
        out[o] = row[i * 4 * s]; out[o + 1] = row[(i * 4 + 1) * s]; out[o + 2] = row[(i * 4 + 2) * s]; out[o + 3] = row[(i * 4 + 3) * s];
        break;
      }
    }
  };
  if (!interlace) {
    const stride = strideFor(w);
    const px = unfilter(raw, 0, h, stride, bpp);
    for (let y = 0; y < h; y++) {
      const row = px.subarray(y * stride, (y + 1) * stride);
      for (let x = 0; x < w; x++) writePixel(x, y, row, x);
    }
  } else {
    let off = 0;
    for (const [sx, sy, dx, dy] of ADAM7) {
      const pw = Math.ceil((w - sx) / dx), ph = Math.ceil((h - sy) / dy);
      if (pw <= 0 || ph <= 0) continue;
      const stride = strideFor(pw);
      const px = unfilter(raw, off, ph, stride, bpp);
      off += ph * (stride + 1);
      for (let py = 0; py < ph; py++) {
        const row = px.subarray(py * stride, (py + 1) * stride);
        for (let pxi = 0; pxi < pw; pxi++) writePixel(sx + pxi * dx, sy + py * dy, row, pxi);
      }
    }
  }
  return { w, h, rgba: out };
}

// ---------------------------------------------------------------------------------------------- encoder
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  out.writeUInt32BE(crc, 8 + data.length);
  return out;
}

/** Encode straight-alpha RGBA8 as a PNG (colour type 6, filter 0 on every scanline, deflate level 6). */
export function encodePng(img: RgbaImage): Buffer {
  const { w, h, rgba } = img;
  if (rgba.length !== w * h * 4) throw new ImageDecodeError('png encode: buffer size mismatch');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 6 });
  return Buffer.concat([Buffer.from(SIG), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]);
}
