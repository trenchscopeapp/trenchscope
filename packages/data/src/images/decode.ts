// @dexterm/data — one entry point for untrusted image bytes (task-1326): sniff the container by magic
// bytes (never trust a URL suffix or Content-Type), enforce the byte cap, dispatch to the matching pure-TS
// decoder, and shrink the result to a small RGBA thumbnail with an area-average filter. WebP is recognised
// but not decoded (no VP8/VP8L decoder in the zero-dependency tree): it reports `unsupported` honestly and
// the UI draws the placeholder.
import type { RgbaImage, DecodeLimits, ImageFormat } from './types.ts';
import { DEFAULT_LIMITS, ImageDecodeError, sniffFormat } from './types.ts';
import { decodePng } from './png.ts';
import { decodeJpeg } from './jpeg.ts';
import { decodeGif } from './gif.ts';

export interface DecodedImage extends RgbaImage {
  format: ImageFormat;
  /** Source dimensions before the thumbnail resize. */
  srcW: number;
  srcH: number;
}

/** Decode any supported container. Throws ImageDecodeError for junk, unsupported formats or capped inputs. */
export function decodeImage(bytes: Uint8Array, limits: DecodeLimits = DEFAULT_LIMITS): { img: RgbaImage; format: ImageFormat } {
  if (bytes.length > limits.maxBytes) throw new ImageDecodeError(`input is ${bytes.length} bytes, over the ${limits.maxBytes} byte cap`);
  const format = sniffFormat(bytes);
  if (!format) throw new ImageDecodeError('not a png/jpeg/gif/webp (magic bytes)');
  if (format === 'webp') throw new ImageDecodeError('unsupported: webp (no decoder in the zero-dependency tree)');
  const img = format === 'png' ? decodePng(bytes, limits) : format === 'jpeg' ? decodeJpeg(bytes, limits) : decodeGif(bytes, limits);
  return { img, format };
}

/**
 * Area-average resample to exactly `dw × dh` (box filter over the source rectangle each destination pixel
 * covers). Alpha is averaged premultiplied so transparent edge pixels do not bleed their (usually black)
 * colour into the thumbnail. Works for down- and up-scaling.
 */
export function resample(src: RgbaImage, dw: number, dh: number): RgbaImage {
  dw = Math.max(1, Math.floor(dw)); dh = Math.max(1, Math.floor(dh));
  const { w: sw, h: sh, rgba } = src;
  const out = new Uint8Array(dw * dh * 4);
  const xs = sw / dw, ys = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = y * ys, y1 = (y + 1) * ys;
    const iy0 = Math.floor(y0), iy1 = Math.min(sh, Math.ceil(y1));
    for (let x = 0; x < dw; x++) {
      const x0 = x * xs, x1 = (x + 1) * xs;
      const ix0 = Math.floor(x0), ix1 = Math.min(sw, Math.ceil(x1));
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let sy = iy0; sy < iy1; sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        for (let sx = ix0; sx < ix1; sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          const wgt = wx * wy;
          const o = (sy * sw + sx) * 4;
          const al = rgba[o + 3] / 255;
          r += rgba[o] * al * wgt; g += rgba[o + 1] * al * wgt; b += rgba[o + 2] * al * wgt; a += al * wgt;
          wsum += wgt;
        }
      }
      const oo = (y * dw + x) * 4;
      if (wsum <= 0 || a <= 0) { out[oo] = 0; out[oo + 1] = 0; out[oo + 2] = 0; out[oo + 3] = 0; continue; }
      out[oo] = Math.round(r / a); out[oo + 1] = Math.round(g / a); out[oo + 2] = Math.round(b / a);
      out[oo + 3] = Math.round((a / wsum) * 255);
    }
  }
  return { w: dw, h: dh, rgba: out };
}

/** Shrink to fit inside `max × max` keeping the aspect ratio; never upscales. */
export function fitWithin(src: RgbaImage, max: number): RgbaImage {
  if (src.w <= max && src.h <= max) return src;
  const s = max / Math.max(src.w, src.h);
  return resample(src, Math.max(1, Math.round(src.w * s)), Math.max(1, Math.round(src.h * s)));
}

/** Decode + shrink to a thumbnail no larger than `thumbMax` on its longer side. */
export function decodeThumbnail(bytes: Uint8Array, thumbMax = 96, limits: DecodeLimits = DEFAULT_LIMITS): DecodedImage {
  const { img, format } = decodeImage(bytes, limits);
  const small = fitWithin(img, thumbMax);
  return { ...small, format, srcW: img.w, srcH: img.h };
}
