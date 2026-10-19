// @dexterm/data — shared image types + caps (task-1326). Every decoder checks the header against these
// limits BEFORE allocating a pixel buffer, so a hostile header (4 billion × 4 billion) costs nothing.

/** Straight-alpha RGBA8, row-major, `rgba.length === w * h * 4`. */
export interface RgbaImage {
  w: number;
  h: number;
  rgba: Uint8Array;
}

export interface DecodeLimits {
  /** Largest width or height accepted. */
  maxDim: number;
  /** Largest width × height accepted. */
  maxPixels: number;
  /** Largest encoded input (and compressed payload) accepted. */
  maxBytes: number;
}

/** 2048², 4 MP, 2 MiB: comfortably above any real coin logo, far below anything that could hurt. */
export const DEFAULT_LIMITS: DecodeLimits = { maxDim: 2048, maxPixels: 4 * 1024 * 1024, maxBytes: 2 * 1024 * 1024 };

export class ImageDecodeError extends Error {
  constructor(msg: string) { super(msg); this.name = 'ImageDecodeError'; }
}

export function checkDims(w: number, h: number, limits: DecodeLimits, what: string): void {
  if (!(w > 0 && h > 0)) throw new ImageDecodeError(`${what}: empty image`);
  if (w > limits.maxDim || h > limits.maxDim) throw new ImageDecodeError(`${what}: ${w}×${h} exceeds the ${limits.maxDim} px dimension cap`);
  if (w * h > limits.maxPixels) throw new ImageDecodeError(`${what}: ${w}×${h} exceeds the pixel cap`);
}

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

/** Sniff the container by magic bytes only (never by the URL or the Content-Type header). */
export function sniffFormat(b: Uint8Array): ImageFormat | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  return null;
}
