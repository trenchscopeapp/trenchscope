// @dexterm/data — JPEG decoder (task-1326): baseline + extended sequential + progressive Huffman JPEG
// (SOF0/SOF1/SOF2), 8-bit, grey or YCbCr/RGB with any chroma subsampling and restart intervals, into
// straight-alpha RGBA8. Pure TypeScript, bounds-checked: a hostile file can only make this throw. Not
// supported (throws ImageDecodeError): arithmetic coding, 12-bit, lossless, hierarchical, CMYK/YCCK.
// Structure follows ITU T.81 (Annex F huffman decoding, G.1.2 progressive refinement).
import type { RgbaImage, DecodeLimits } from './types.ts';
import { DEFAULT_LIMITS, ImageDecodeError, checkDims } from './types.ts';

const ZIGZAG = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

interface Huffman { maxcode: Int32Array; mincode: Int32Array; valptr: Int32Array; symbols: Uint8Array }

function buildHuffman(counts: Uint8Array, symbols: Uint8Array): Huffman {
  const maxcode = new Int32Array(18).fill(-1), mincode = new Int32Array(17), valptr = new Int32Array(17);
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    const n = counts[len - 1];
    valptr[len] = k;
    mincode[len] = code;
    if (n > 0) { code += n; k += n; maxcode[len] = code - 1; } else maxcode[len] = -1;
    code <<= 1;
  }
  if (k !== symbols.length) throw new ImageDecodeError('jpeg: huffman table symbol count mismatch');
  return { maxcode, mincode, valptr, symbols };
}

interface Component {
  id: number; h: number; v: number; tq: number;
  blocksPerLine: number; blocksPerColumn: number; blocksPerLineForMcu: number; blocksPerColumnForMcu: number;
  blockData: Int16Array; pred: number; dc?: Huffman; ac?: Huffman;
}

interface Frame {
  progressive: boolean; width: number; height: number; maxH: number; maxV: number;
  mcusPerLine: number; mcusPerColumn: number; components: Component[];
}

class BitReader {
  pos: number;
  readonly data: Uint8Array;
  private bitBuf = 0;
  private bitCnt = 0;
  /** A marker was hit inside entropy-coded data: bits read as zeros until the scan loop handles it. */
  markerHit = false;
  constructor(data: Uint8Array, start: number) { this.data = data; this.pos = start; }
  readBit(): number {
    if (this.bitCnt === 0) {
      if (this.markerHit || this.pos >= this.data.length) { this.markerHit = true; return 0; }
      let b = this.data[this.pos];
      if (b === 0xff) {
        const nxt = this.data[this.pos + 1];
        if (nxt === 0) { this.pos += 2; }
        else if (nxt === undefined) { this.markerHit = true; return 0; }
        else if (nxt >= 0xd0 && nxt <= 0xd7) { this.markerHit = true; return 0; } // RSTn: handled by the scan loop
        else { this.markerHit = true; return 0; }
      } else this.pos += 1;
      this.bitBuf = b; this.bitCnt = 8;
    }
    this.bitCnt -= 1;
    return (this.bitBuf >> this.bitCnt) & 1;
  }
  receive(n: number): number { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | this.readBit(); return v; }
  receiveExtend(s: number): number {
    if (s === 0) return 0;
    if (s > 16) throw new ImageDecodeError('jpeg: bad magnitude category');
    const v = this.receive(s);
    return v < 1 << (s - 1) ? v - (1 << s) + 1 : v;
  }
  decode(h: Huffman): number {
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | this.readBit();
      if (h.maxcode[len] >= 0 && code <= h.maxcode[len]) return h.symbols[h.valptr[len] + code - h.mincode[len]];
    }
    if (this.markerHit) return 0; // ran off the end of a scan: decode zeros, the loop stops at the marker
    throw new ImageDecodeError('jpeg: invalid huffman code');
  }
  /** Drop buffered bits (restart / end of scan). */
  reset(): void { this.bitBuf = 0; this.bitCnt = 0; this.markerHit = false; }
}

function decodeScan(data: Uint8Array, start: number, frame: Frame, comps: Component[], restartInterval: number, ss: number, se: number, ah: number, al: number): number {
  const br = new BitReader(data, start);
  const progressive = frame.progressive;
  let eobrun = 0;
  let acState = 0, acNext = 0;

  const decodeBaseline = (c: Component, off: number): void => {
    const t = br.decode(c.dc as Huffman);
    const diff = t === 0 ? 0 : br.receiveExtend(t);
    c.pred += diff;
    c.blockData[off] = c.pred;
    let k = 1;
    while (k < 64) {
      const rs = br.decode(c.ac as Huffman);
      const s = rs & 15, r = rs >> 4;
      if (s === 0) { if (r < 15) break; k += 16; continue; }
      k += r;
      if (k > 63) break;
      c.blockData[off + ZIGZAG[k]] = br.receiveExtend(s);
      k += 1;
    }
  };
  const decodeDCFirst = (c: Component, off: number): void => {
    const t = br.decode(c.dc as Huffman);
    const diff = t === 0 ? 0 : br.receiveExtend(t) << al;
    c.pred += diff;
    c.blockData[off] = c.pred;
  };
  const decodeDCRefine = (c: Component, off: number): void => { if (br.readBit()) c.blockData[off] |= 1 << al; };
  const decodeACFirst = (c: Component, off: number): void => {
    if (eobrun > 0) { eobrun -= 1; return; }
    let k = ss;
    while (k <= se) {
      const rs = br.decode(c.ac as Huffman);
      const s = rs & 15, r = rs >> 4;
      if (s === 0) {
        if (r < 15) { eobrun = br.receive(r) + (1 << r) - 1; break; }
        k += 16; continue;
      }
      k += r;
      if (k > 63) break;
      c.blockData[off + ZIGZAG[k]] = br.receiveExtend(s) * (1 << al);
      k += 1;
    }
  };
  const decodeACRefine = (c: Component, off: number): void => {
    let k = ss, r = 0;
    const bd = c.blockData;
    while (k <= se) {
      const z = off + ZIGZAG[k];
      const sign = bd[z] < 0 ? -1 : 1;
      switch (acState) {
        case 0: {
          const rs = br.decode(c.ac as Huffman);
          const s = rs & 15; r = rs >> 4;
          if (s === 0) {
            if (r < 15) { eobrun = br.receive(r) + (1 << r); acState = 4; }
            else { r = 16; acState = 1; }
          } else {
            if (s !== 1) throw new ImageDecodeError('jpeg: invalid AC refinement');
            acNext = br.receiveExtend(s);
            acState = r ? 2 : 3;
          }
          continue;
        }
        case 1: case 2:
          if (bd[z]) bd[z] += sign * (br.readBit() << al);
          else { r -= 1; if (r === 0) acState = acState === 2 ? 3 : 0; }
          break;
        case 3:
          if (bd[z]) bd[z] += sign * (br.readBit() << al);
          else { bd[z] = acNext << al; acState = 0; }
          break;
        case 4:
          if (bd[z]) bd[z] += sign * (br.readBit() << al);
          break;
      }
      k += 1;
    }
    if (acState === 4) { eobrun -= 1; if (eobrun === 0) acState = 0; }
  };
  const decodeFn = !progressive ? decodeBaseline : ss === 0 ? (ah === 0 ? decodeDCFirst : decodeDCRefine) : (ah === 0 ? decodeACFirst : decodeACRefine);

  const blockAt = (c: Component, row: number, col: number): number => {
    if (row < 0 || col < 0 || row >= c.blocksPerColumnForMcu || col >= c.blocksPerLineForMcu) throw new ImageDecodeError('jpeg: block out of range');
    return 64 * (row * c.blocksPerLineForMcu + col);
  };

  const single = comps.length === 1;
  const total = single ? comps[0].blocksPerLine * comps[0].blocksPerColumn : frame.mcusPerLine * frame.mcusPerColumn;
  const perRestart = restartInterval > 0 ? restartInterval : total;
  let mcu = 0;
  while (mcu < total) {
    for (const c of comps) c.pred = 0;
    eobrun = 0; acState = 0;
    for (let n = 0; n < perRestart && mcu < total; n++, mcu++) {
      if (single) {
        const c = comps[0];
        const row = Math.floor(mcu / c.blocksPerLine), col = mcu % c.blocksPerLine;
        decodeFn(c, blockAt(c, row, col));
      } else {
        const mr = Math.floor(mcu / frame.mcusPerLine), mc = mcu % frame.mcusPerLine;
        for (const c of comps) for (let j = 0; j < c.v; j++) for (let k = 0; k < c.h; k++) decodeFn(c, blockAt(c, mr * c.v + j, mc * c.h + k));
      }
      if (br.markerHit && br.pos >= data.length) break;
    }
    // Expect a marker: RSTn continues, anything else ends the scan.
    br.reset();
    let p = br.pos;
    while (p < data.length && data[p] !== 0xff) p += 1;
    while (p + 1 < data.length && data[p] === 0xff && data[p + 1] === 0xff) p += 1;
    if (p + 1 >= data.length) return data.length;
    const m = data[p + 1];
    if (m >= 0xd0 && m <= 0xd7) { br.pos = p + 2; continue; }
    return p;
  }
  // consumed every MCU: find the next marker
  let p = br.pos;
  while (p < data.length && !(data[p] === 0xff && data[p + 1] !== 0 && !(data[p + 1] >= 0xd0 && data[p + 1] <= 0xd7))) p += 1;
  return p;
}

// Separable float IDCT with a precomputed cosine table; exact enough for display and simple to audit.
const COS = (() => {
  const t = new Float32Array(64);
  for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) t[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  return t;
})();

function idctBlock(src: Int16Array, off: number, q: Int32Array, out: Uint8Array, outOff: number, stride: number, tmp: Float32Array): void {
  // rows: tmp[y][x] = sum_u C(u) F(y,u) cos(x,u)  where F stored natural order [v*8+u]
  for (let v = 0; v < 8; v++) {
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let u = 0; u < 8; u++) s += src[off + v * 8 + u] * q[v * 8 + u] * COS[x * 8 + u];
      tmp[v * 8 + x] = s;
    }
  }
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let s = 0;
      for (let v = 0; v < 8; v++) s += tmp[v * 8 + x] * COS[y * 8 + v];
      const val = Math.round(s / 4 + 128);
      out[outOff + y * stride + x] = val < 0 ? 0 : val > 255 ? 255 : val;
    }
  }
}

function clamp8(v: number): number { return v < 0 ? 0 : v > 255 ? 255 : v; }

export function decodeJpeg(data: Uint8Array, limits: DecodeLimits = DEFAULT_LIMITS): RgbaImage {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) throw new ImageDecodeError('jpeg: bad signature');
  if (data.length > limits.maxBytes) throw new ImageDecodeError('jpeg: input over the byte cap');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const qt: Int32Array[] = [];
  const dcTables: Huffman[] = [], acTables: Huffman[] = [];
  let frame: Frame | null = null;
  let restartInterval = 0;
  let adobeTransform: number | null = null;
  let jfif = false;
  let pos = 2;
  const u16 = (p: number): number => { if (p + 2 > data.length) throw new ImageDecodeError('jpeg: truncated'); return dv.getUint16(p); };
  while (pos < data.length) {
    if (data[pos] !== 0xff) { pos += 1; continue; }
    const marker = data[pos + 1];
    if (marker === undefined) break;
    if (marker === 0xff) { pos += 1; continue; } // fill byte
    pos += 2;
    if (marker === 0xd8) continue; // SOI
    if (marker === 0xd9) break; // EOI
    if (marker >= 0xd0 && marker <= 0xd7) continue; // stray RST
    const len = u16(pos);
    const segEnd = pos + len;
    if (segEnd > data.length) throw new ImageDecodeError('jpeg: segment overruns the file');
    const seg = pos + 2;
    if (marker >= 0xe0 && marker <= 0xef) {
      if (marker === 0xe0 && len >= 7 && data[seg] === 0x4a && data[seg + 1] === 0x46 && data[seg + 2] === 0x49 && data[seg + 3] === 0x46) jfif = true;
      if (marker === 0xee && len >= 14 && data[seg] === 0x41 && data[seg + 1] === 0x64 && data[seg + 2] === 0x6f && data[seg + 3] === 0x62 && data[seg + 4] === 0x65) adobeTransform = data[seg + 11];
      pos = segEnd; continue;
    }
    switch (marker) {
      case 0xdb: { // DQT
        let p = seg;
        while (p < segEnd) {
          const pq = data[p] >> 4, tq = data[p] & 15;
          p += 1;
          if (tq > 3) throw new ImageDecodeError('jpeg: bad quant table id');
          const t = new Int32Array(64);
          for (let k = 0; k < 64; k++) {
            if (pq === 0) { t[ZIGZAG[k]] = data[p]; p += 1; }
            else { t[ZIGZAG[k]] = u16(p); p += 2; }
          }
          qt[tq] = t;
        }
        break;
      }
      case 0xc0: case 0xc1: case 0xc2: { // SOF
        if (frame) throw new ImageDecodeError('jpeg: multiple frames');
        if (data[seg] !== 8) throw new ImageDecodeError('jpeg: only 8-bit precision is supported');
        const height = u16(seg + 1), width = u16(seg + 3), n = data[seg + 5];
        checkDims(width, height, limits, 'jpeg');
        if (n !== 1 && n !== 3) throw new ImageDecodeError(`jpeg: ${n}-component images are not supported`);
        const comps: Component[] = [];
        let p = seg + 6;
        let maxH = 1, maxV = 1;
        for (let i = 0; i < n; i++) {
          const id = data[p], h = data[p + 1] >> 4, v = data[p + 1] & 15, tq = data[p + 2];
          p += 3;
          if (h < 1 || h > 4 || v < 1 || v > 4) throw new ImageDecodeError('jpeg: bad sampling factor');
          maxH = Math.max(maxH, h); maxV = Math.max(maxV, v);
          comps.push({ id, h, v, tq, blocksPerLine: 0, blocksPerColumn: 0, blocksPerLineForMcu: 0, blocksPerColumnForMcu: 0, blockData: new Int16Array(0), pred: 0 });
        }
        const mcusPerLine = Math.ceil(width / 8 / maxH), mcusPerColumn = Math.ceil(height / 8 / maxV);
        for (const c of comps) {
          c.blocksPerLine = Math.ceil((Math.ceil((width * c.h) / maxH)) / 8);
          c.blocksPerColumn = Math.ceil((Math.ceil((height * c.v) / maxV)) / 8);
          c.blocksPerLineForMcu = mcusPerLine * c.h;
          c.blocksPerColumnForMcu = mcusPerColumn * c.v;
          c.blockData = new Int16Array(c.blocksPerLineForMcu * c.blocksPerColumnForMcu * 64);
        }
        frame = { progressive: marker === 0xc2, width, height, maxH, maxV, mcusPerLine, mcusPerColumn, components: comps };
        break;
      }
      case 0xc3: case 0xc5: case 0xc6: case 0xc7: case 0xc9: case 0xca: case 0xcb: case 0xcd: case 0xce: case 0xcf:
        throw new ImageDecodeError('jpeg: lossless/hierarchical/arithmetic JPEG is not supported');
      case 0xc4: { // DHT
        let p = seg;
        while (p < segEnd) {
          const tc = data[p] >> 4, th = data[p] & 15;
          p += 1;
          if (th > 3) throw new ImageDecodeError('jpeg: bad huffman table id');
          const counts = data.subarray(p, p + 16);
          p += 16;
          let total = 0;
          for (let i = 0; i < 16; i++) total += counts[i];
          if (total > 256 || p + total > segEnd) throw new ImageDecodeError('jpeg: bad huffman table');
          const symbols = data.subarray(p, p + total);
          p += total;
          (tc === 0 ? dcTables : acTables)[th] = buildHuffman(counts, symbols);
        }
        break;
      }
      case 0xdd: restartInterval = u16(seg); break; // DRI
      case 0xda: { // SOS
        if (!frame) throw new ImageDecodeError('jpeg: scan before frame');
        const n = data[seg];
        let p = seg + 1;
        const comps: Component[] = [];
        for (let i = 0; i < n; i++) {
          const id = data[p], td = data[p + 1] >> 4, ta = data[p + 1] & 15;
          p += 2;
          const c = frame.components.find((x) => x.id === id);
          if (!c) throw new ImageDecodeError('jpeg: scan names an unknown component');
          c.dc = dcTables[td]; c.ac = acTables[ta];
          comps.push(c);
        }
        const ss = data[p], se = data[p + 1], ah = data[p + 2] >> 4, al = data[p + 2] & 15;
        p += 3;
        if (!frame.progressive) {
          for (const c of comps) if (!c.dc || !c.ac) throw new ImageDecodeError('jpeg: missing huffman table');
        } else {
          if (ss > se || se > 63 || al > 13) throw new ImageDecodeError('jpeg: bad progressive scan parameters');
          for (const c of comps) { if (ss === 0 && ah === 0 && !c.dc) throw new ImageDecodeError('jpeg: missing DC table'); if (ss > 0 && !c.ac) throw new ImageDecodeError('jpeg: missing AC table'); }
          if (ss > 0 && comps.length !== 1) throw new ImageDecodeError('jpeg: progressive AC scans must be non-interleaved');
        }
        pos = decodeScan(data, p, frame, comps, restartInterval, ss, se, ah, al);
        continue;
      }
      case 0xdc: break; // DNL: ignored
      default: break; // COM and anything else: skipped by length
    }
    pos = segEnd;
  }
  if (!frame) throw new ImageDecodeError('jpeg: no frame');
  // ---- dequantize + IDCT each component into a sample plane
  const planes: Array<{ data: Uint8Array; stride: number; c: Component }> = [];
  const tmp = new Float32Array(64);
  for (const c of frame.components) {
    const q = qt[c.tq];
    if (!q) throw new ImageDecodeError('jpeg: missing quant table');
    const stride = c.blocksPerLine * 8;
    const plane = new Uint8Array(stride * c.blocksPerColumn * 8);
    for (let row = 0; row < c.blocksPerColumn; row++) {
      for (let col = 0; col < c.blocksPerLine; col++) {
        idctBlock(c.blockData, 64 * (row * c.blocksPerLineForMcu + col), q, plane, row * 8 * stride + col * 8, stride, tmp);
      }
    }
    planes.push({ data: plane, stride, c });
  }
  // ---- colour conversion. Subsampled planes are upsampled with linear interpolation between sample
  // centres (libjpeg's "fancy upsampling"), so the output matches djpeg to within a level.
  const { width, height, maxH, maxV } = frame;
  const out = new Uint8Array(width * height * 4);
  const sampleOf = (p: { data: Uint8Array; stride: number; c: Component }, x: number, y: number): number => {
    const fx = p.c.h / maxH, fy = p.c.v / maxV;
    if (fx === 1 && fy === 1) return p.data[y * p.stride + x];
    const pw = p.c.blocksPerLine * 8, ph = p.c.blocksPerColumn * 8;
    const sx = Math.min(Math.max((x + 0.5) * fx - 0.5, 0), pw - 1), sy = Math.min(Math.max((y + 0.5) * fy - 0.5, 0), ph - 1);
    const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(pw - 1, x0 + 1), y1 = Math.min(ph - 1, y0 + 1);
    const tx = sx - x0, ty = sy - y0;
    const d = p.data, s = p.stride;
    const top = d[y0 * s + x0] * (1 - tx) + d[y0 * s + x1] * tx;
    const bot = d[y1 * s + x0] * (1 - tx) + d[y1 * s + x1] * tx;
    return top * (1 - ty) + bot * ty;
  };
  if (planes.length === 1) {
    const p = planes[0];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const g = sampleOf(p, x, y), o = (y * width + x) * 4;
      out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255;
    }
    return { w: width, h: height, rgba: out };
  }
  // Transform: Adobe flag wins; JFIF implies YCbCr; component ids 'R','G','B' mean RGB; default YCbCr.
  const ids = frame.components.map((c) => c.id);
  const isRgbIds = ids[0] === 0x52 && ids[1] === 0x47 && ids[2] === 0x42;
  const ycc = adobeTransform !== null ? adobeTransform !== 0 : jfif ? true : !isRgbIds;
  const [p0, p1, p2] = planes;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = sampleOf(p0, x, y), b = sampleOf(p1, x, y), c = sampleOf(p2, x, y);
      const o = (y * width + x) * 4;
      if (ycc) {
        const cb = b - 128, cr = c - 128;
        out[o] = clamp8(Math.round(a + 1.402 * cr));
        out[o + 1] = clamp8(Math.round(a - 0.344136 * cb - 0.714136 * cr));
        out[o + 2] = clamp8(Math.round(a + 1.772 * cb));
      } else { out[o] = a; out[o + 1] = b; out[o + 2] = c; }
      out[o + 3] = 255;
    }
  }
  return { w: width, h: height, rgba: out };
}
