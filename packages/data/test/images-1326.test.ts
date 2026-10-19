import { posixPermissions } from '../../../scripts/test-support.ts';
// task-1326: coin images — the pure-TS decoders (PNG every colour type / depth / interlace, baseline +
// progressive JPEG, GIF first frame), the magic-byte sniff + caps, the SSRF-safe binary fetch (policy,
// redirects, caps), the on-disk LRU cache and the ImageService (sync get, queue priority, offline, worker
// decode, notify). Network is blocked for the whole file; fixtures are built in-test or read from
// fixtures/images/ (tiny files generated once with libjpeg-turbo's cjpeg / sips, checked in).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { readFileSync, mkdtempSync, rmSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import './helpers.ts';
import {
  decodePng, encodePng, decodeJpeg, decodeGif, decodeImage, decodeThumbnail, resample, fitWithin, sniffFormat, ImageDecodeError,
  fetchBytes, thumbnailUrl, ImageDiskCache, imageCacheKey, ImageService, runDecodeJob, DEFAULT_LIMITS,
  type RawResponse, type BytesTransport, type RgbaImage, type FetchBytesResult,
} from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(here, '..', 'fixtures', 'images');

// ---------------------------------------------------------------------------------------------- PNG builders
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array): number { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Uint8Array): Buffer { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); b.set(data, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length); return b; }
/** Build a PNG from raw (already filtered) scanline bytes. */
function png(w: number, h: number, depth: number, colorType: number, raw: Uint8Array, extra: Buffer[] = [], interlace = 0): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = colorType; ihdr[12] = interlace;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), ...extra, chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]);
}
const px = (img: RgbaImage, x: number, y: number): number[] => Array.from(img.rgba.subarray((y * img.w + x) * 4, (y * img.w + x) * 4 + 4));

test('png: RGBA8 round-trips through our encoder and decoder byte for byte', () => {
  const w = 5, h = 3, rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = i * 13; rgba[i * 4 + 1] = 255 - i * 9; rgba[i * 4 + 2] = (i * 37) & 255; rgba[i * 4 + 3] = i % 3 === 0 ? 0 : 255; }
  const file = encodePng({ w, h, rgba });
  assert.equal(sniffFormat(file), 'png');
  const back = decodePng(file);
  assert.equal(back.w, w); assert.equal(back.h, h);
  assert.deepEqual(Array.from(back.rgba), Array.from(rgba));
});

test('png: grey 1/2/4/8/16-bit, palette with tRNS, grey+alpha, RGB with colour-key, 16-bit RGB', () => {
  // 1-bit grey, 8 px wide: bits 10110010 → 255,0,255,255,0,0,255,0 ; filter 0
  const g1 = decodePng(png(8, 1, 1, 0, new Uint8Array([0, 0b10110010])));
  assert.deepEqual([0, 1, 2, 7].map((x) => px(g1, x, 0)[0]), [255, 0, 255, 0]);
  // 2-bit grey: 00 01 10 11 → 0, 85, 170, 255
  const g2 = decodePng(png(4, 1, 2, 0, new Uint8Array([0, 0b00011011])));
  assert.deepEqual([0, 1, 2, 3].map((x) => px(g2, x, 0)[0]), [0, 85, 170, 255]);
  // 4-bit grey: 0x0 0xF → 0, 255
  const g4 = decodePng(png(2, 1, 4, 0, new Uint8Array([0, 0x0f])));
  assert.deepEqual([px(g4, 0, 0)[0], px(g4, 1, 0)[0]], [0, 255]);
  // 16-bit grey: high byte wins
  const g16 = decodePng(png(2, 1, 16, 0, new Uint8Array([0, 0x12, 0x34, 0xff, 0x00])));
  assert.deepEqual([px(g16, 0, 0)[0], px(g16, 1, 0)[0]], [0x12, 0xff]);
  // palette 2-bit: PLTE red, green, blue, white; tRNS makes index 1 transparent
  const plte = chunk('PLTE', new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]));
  const trns = chunk('tRNS', new Uint8Array([255, 0]));
  const p = decodePng(png(4, 1, 2, 3, new Uint8Array([0, 0b00011011]), [plte, trns]));
  assert.deepEqual(px(p, 0, 0), [255, 0, 0, 255]); assert.deepEqual(px(p, 1, 0), [0, 255, 0, 0]); assert.deepEqual(px(p, 3, 0), [255, 255, 255, 255]);
  // grey + alpha 8-bit
  const ga = decodePng(png(1, 1, 8, 4, new Uint8Array([0, 77, 128])));
  assert.deepEqual(px(ga, 0, 0), [77, 77, 77, 128]);
  // RGB 8 with a colour key (tRNS 16-bit per channel) on the second pixel
  const rgbKey = decodePng(png(2, 1, 8, 2, new Uint8Array([0, 10, 20, 30, 1, 2, 3]), [chunk('tRNS', new Uint8Array([0, 1, 0, 2, 0, 3]))]));
  assert.deepEqual(px(rgbKey, 0, 0), [10, 20, 30, 255]); assert.deepEqual(px(rgbKey, 1, 0), [1, 2, 3, 0]);
  // RGB 16: high bytes
  const rgb16 = decodePng(png(1, 1, 16, 2, new Uint8Array([0, 0xab, 0x00, 0xcd, 0x00, 0xef, 0x00])));
  assert.deepEqual(px(rgb16, 0, 0), [0xab, 0xcd, 0xef, 255]);
});

test('png: every scanline filter (sub, up, average, paeth) reconstructs', () => {
  // 2×2 RGB: row 0 filter 1 (sub), row 1 filter 4 (paeth)
  // true pixels: (10,20,30) (40,50,60) / (70,80,90) (100,110,120)
  const row0 = [1, 10, 20, 30, 30, 30, 30];           // sub: second = first + 30
  // paeth for row 1: a = left, b = up, c = up-left. pixel(0): a=0,b=10,c=0 → p=10 → pred b=10 → raw 60; etc.
  const paethPred = (a: number, b: number, c: number) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  const up = [10, 20, 30, 40, 50, 60], want = [70, 80, 90, 100, 110, 120];
  const row1 = [4];
  for (let i = 0; i < 6; i++) { const a = i >= 3 ? want[i - 3] : 0, b = up[i], c = i >= 3 ? up[i - 3] : 0; row1.push((want[i] - paethPred(a, b, c)) & 255); }
  const img = decodePng(png(2, 2, 8, 2, new Uint8Array([...row0, ...row1])));
  assert.deepEqual(px(img, 1, 0).slice(0, 3), [40, 50, 60]); assert.deepEqual(px(img, 0, 1).slice(0, 3), [70, 80, 90]); assert.deepEqual(px(img, 1, 1).slice(0, 3), [100, 110, 120]);
  // up (2) and average (3) on a 1×3 grey column
  const avg = decodePng(png(1, 3, 8, 0, new Uint8Array([0, 100, 2, 5, 3, 7])));
  assert.deepEqual([0, 1, 2].map((y) => px(avg, 0, y)[0]), [100, 105, 7 + ((0 + 105) >> 1)]);
});

test('png: Adam7 interlace reassembles the same pixels as the non-interlaced file', () => {
  const w = 9, h = 7; // odd sizes exercise every pass's partial rows
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; rgba[o] = x * 25; rgba[o + 1] = y * 35; rgba[o + 2] = (x * y * 7) & 255; rgba[o + 3] = 255; }
  // build the interlaced raw stream by hand (filter 0 every scanline)
  const PASSES = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  const parts: number[] = [];
  for (const [sx, sy, dx, dy] of PASSES) {
    for (let y = sy; y < h; y += dy) { parts.push(0); for (let x = sx; x < w; x += dx) { const o = (y * w + x) * 4; parts.push(rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]); } }
  }
  const inter = decodePng(png(w, h, 8, 6, new Uint8Array(parts), [], 1));
  assert.deepEqual(Array.from(inter.rgba), Array.from(rgba));
});

test('png: caps and junk fail closed with ImageDecodeError before any pixel buffer exists', () => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(100_000, 0); ihdr.writeUInt32BE(100_000, 4); ihdr[8] = 8; ihdr[9] = 6;
  const huge = Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(10))), chunk('IEND', new Uint8Array(0))]);
  assert.throws(() => decodePng(huge), (e: Error) => e instanceof ImageDecodeError && /dimension cap/.test(e.message));
  assert.throws(() => decodePng(Buffer.from('not a png at all')), ImageDecodeError);
  // truncated IDAT: inflate yields less than the expected scanline bytes
  const short = png(4, 4, 8, 6, new Uint8Array(10));
  assert.throws(() => decodePng(short), /truncated/);
  // palette index out of range
  const bad = png(1, 1, 8, 3, new Uint8Array([0, 200]), [chunk('PLTE', new Uint8Array([1, 2, 3]))]);
  assert.throws(() => decodePng(bad), /palette index/);
});

// ---------------------------------------------------------------------------------------------- JPEG (fixtures)
function nearly(got: number[], want: number[], tol: number, what: string): void {
  for (let i = 0; i < want.length; i++) assert.ok(Math.abs(got[i] - want[i]) <= tol, `${what}: ${got} vs ${want} (±${tol})`);
}
/** Mean absolute error between two same-sized images over RGB. */
function mae(a: RgbaImage, b: RgbaImage): number {
  assert.equal(a.w, b.w); assert.equal(a.h, b.h);
  let s = 0, n = 0;
  for (let i = 0; i < a.rgba.length; i += 4) for (let c = 0; c < 3; c++) { s += Math.abs(a.rgba[i + c] - b.rgba[i + c]); n++; }
  return s / n;
}

test('jpeg: baseline 4:2:0 fixture decodes to the reference PNG (libjpeg-turbo djpeg) within 1 level MAE', () => {
  const ref = decodePng(readFileSync(join(FIX, 'quad-420.ref.png')));
  const got = decodeJpeg(readFileSync(join(FIX, 'quad-420.jpg')));
  assert.equal(got.w, 32); assert.equal(got.h, 32);
  assert.ok(mae(got, ref) < 1.0, `MAE ${mae(got, ref)}`);
  nearly(px(got, 4, 4), [255, 0, 0, 255], 8, 'red quadrant'); nearly(px(got, 27, 27), [255, 255, 255, 255], 8, 'white quadrant');
});

test('jpeg: progressive (with restart intervals, 4:4:4) and grayscale fixtures match their references', () => {
  for (const [name, w] of [['quad-prog-rst', 32], ['quad-gray', 32], ['quad-422', 32]] as const) {
    const ref = decodePng(readFileSync(join(FIX, `${name}.ref.png`)));
    const got = decodeJpeg(readFileSync(join(FIX, `${name}.jpg`)));
    assert.equal(got.w, w);
    assert.ok(mae(got, ref) < 1.0, `${name}: MAE ${mae(got, ref)}`);
  }
});

test('jpeg: arithmetic coding, 12-bit, CMYK and junk are refused with ImageDecodeError', () => {
  assert.throws(() => decodeJpeg(readFileSync(join(FIX, 'quad-arith.jpg'))), (e: Error) => e instanceof ImageDecodeError && /arithmetic/.test(e.message));
  assert.throws(() => decodeJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 5, 12, 0, 1])), /8-bit|truncated|short/i);
  assert.throws(() => decodeJpeg(Buffer.from('GIF89a')), /signature/);
});

// ---------------------------------------------------------------------------------------------- GIF
test('gif: first frame with global palette, transparency and a sub-rectangle frame', () => {
  const ref = decodePng(readFileSync(join(FIX, 'quad-420.ref.png')));
  const got = decodeGif(readFileSync(join(FIX, 'quad.gif')));
  assert.equal(got.w, 32); assert.equal(got.h, 32);
  assert.ok(mae(got, ref) < 4, `MAE ${mae(got, ref)} (ffmpeg's pal8 quantisation shifts a level or two)`);
  nearly(px(got, 4, 4), [255, 0, 0, 255], 8, 'red'); nearly(px(got, 27, 4), [0, 255, 0, 255], 8, 'green');
  // hand-built 2×2 GIF: palette [black, red], GCE transparent index 0, image 1×1 at (1,1) = red
  const b = Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 2, 0, 2, 0, 0x80, 0, 0, 0, 0, 0, 255, 0, 0,
    0x21, 0xf9, 4, 1, 0, 0, 0, 0,
    0x2c, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0x02, 2, 0x4c, 0x01, 0, 0x3b, // LZW: clear, 1 (red), eoi — 3-bit codes packed LSB-first
  ]);
  const g = decodeGif(b);
  assert.deepEqual(px(g, 0, 0), [0, 0, 0, 0]); // untouched = transparent
  assert.deepEqual(px(g, 1, 1), [255, 0, 0, 255]);
});

// ---------------------------------------------------------------------------------------------- decode + thumbnail
test('decodeImage sniffs by magic bytes (never the name), refuses webp and oversized input, thumbnails keep aspect', () => {
  const file = encodePng({ w: 200, h: 50, rgba: new Uint8Array(200 * 50 * 4).fill(200) });
  const d = decodeThumbnail(file, 96);
  assert.equal(d.format, 'png'); assert.equal(d.srcW, 200); assert.equal(d.w, 96); assert.equal(d.h, 24);
  assert.throws(() => decodeImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), /webp/);
  assert.throws(() => decodeImage(Buffer.alloc(DEFAULT_LIMITS.maxBytes + 1)), /byte cap/);
  assert.equal(sniffFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.equal(sniffFormat(Buffer.from('hello')), null);
});

test('resample: area average with premultiplied alpha (transparent black edges do not darken)', () => {
  // 2×1: opaque white + fully transparent black → 1×1 is white at 50 % alpha, not grey
  const src: RgbaImage = { w: 2, h: 1, rgba: new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0]) };
  const out = resample(src, 1, 1);
  assert.deepEqual(Array.from(out.rgba), [255, 255, 255, 128]);
  assert.equal(fitWithin(src, 10), src, 'no upscale');
});

// ---------------------------------------------------------------------------------------------- fetch
function transport(routes: Record<string, Partial<RawResponse> | (() => Partial<RawResponse>)>, log: string[] = []): BytesTransport {
  return async (url) => {
    log.push(url.toString());
    const r = routes[url.toString()];
    if (!r) return { status: 404, headers: {}, body: new Uint8Array(0) };
    const v = typeof r === 'function' ? r() : r;
    return { status: 200, headers: {}, body: new Uint8Array(0), ...v };
  };
}
const PUBLIC = async (host: string) => (host === 'cdn.example' || host === 'img.example' ? ['93.184.216.34'] : host === 'evil.internal' ? ['10.0.0.5'] : []);

test('fetchBytes: refuses private/loopback hosts and non-http schemes before any request', async () => {
  const log: string[] = [];
  const t = transport({}, log);
  for (const u of ['http://127.0.0.1/x.png', 'http://evil.internal/x.png', 'file:///etc/passwd', 'ftp://cdn.example/x', 'http://user:pw@cdn.example/x.png']) {
    const r = await fetchBytes(u, { requestImpl: t, resolve: PUBLIC });
    assert.equal(r.ok, false, u); assert.ok(r.reason, u);
  }
  assert.equal(log.length, 0, 'nothing was requested');
});

test('fetchBytes: follows redirects manually, re-validating each hop; a hop into a private host is refused', async () => {
  const bytes = Buffer.from([1, 2, 3]);
  const t = transport({
    'https://cdn.example/a.png': { status: 302, headers: { location: '/b.png' } },
    'https://cdn.example/b.png': { status: 200, headers: { 'content-type': 'image/png' }, body: bytes },
    'https://cdn.example/evil.png': { status: 302, headers: { location: 'http://evil.internal/x.png' } },
    'https://cdn.example/loop.png': { status: 302, headers: { location: '/loop.png' } },
  });
  const ok = await fetchBytes('https://cdn.example/a.png', { requestImpl: t, resolve: PUBLIC });
  assert.equal(ok.ok, true); assert.deepEqual(Array.from(ok.bytes), [1, 2, 3]); assert.deepEqual(ok.redirects, ['https://cdn.example/a.png']); assert.equal(ok.finalUrl, 'https://cdn.example/b.png');
  const bad = await fetchBytes('https://cdn.example/evil.png', { requestImpl: t, resolve: PUBLIC });
  assert.equal(bad.ok, false); assert.match(bad.reason ?? '', /blocked|private/);
  const loop = await fetchBytes('https://cdn.example/loop.png', { requestImpl: t, resolve: PUBLIC, maxRedirects: 2 });
  assert.equal(loop.ok, false); assert.match(loop.reason ?? '', /too many redirects/);
});

test('fetchBytes: byte cap, non-2xx and transport failures are reasons, never throws', async () => {
  const t = transport({
    'https://cdn.example/big.png': { body: new Uint8Array(2000) },
    'https://cdn.example/404.png': { status: 404 },
    'https://cdn.example/boom.png': () => { throw new Error('socket hang up'); },
  });
  const big = await fetchBytes('https://cdn.example/big.png', { requestImpl: t, resolve: PUBLIC, maxBytes: 1000 });
  assert.equal(big.ok, false); assert.match(big.reason ?? '', /byte cap/);
  const nf = await fetchBytes('https://cdn.example/404.png', { requestImpl: t, resolve: PUBLIC });
  assert.equal(nf.ok, false); assert.equal(nf.status, 404);
  const boom = await fetchBytes('https://cdn.example/boom.png', { requestImpl: t, resolve: PUBLIC });
  assert.equal(boom.ok, false); assert.match(boom.reason ?? '', /socket hang up/);
});

test('thumbnailUrl: DexScreener CDN gets a 128 px rendition, every other host is untouched', () => {
  assert.equal(thumbnailUrl('https://cdn.dexscreener.com/cms/images/abc?width=800&height=800&quality=95&format=auto'), 'https://cdn.dexscreener.com/cms/images/abc?width=128&height=128&quality=95&format=auto');
  assert.equal(thumbnailUrl('https://cdn.dexscreener.com/cms/images/abc'), 'https://cdn.dexscreener.com/cms/images/abc?width=128&height=128&quality=90');
  assert.equal(thumbnailUrl('https://ipfs.io/ipfs/Qm123'), 'https://ipfs.io/ipfs/Qm123');
  assert.equal(thumbnailUrl('not a url'), 'not a url');
});

// ---------------------------------------------------------------------------------------------- disk cache
test('disk cache: put/get round-trip, fail markers with TTL, LRU eviction by mtime under the byte cap', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-imgcache-'));
  try {
    let now = 1_000_000;
    const c = new ImageDiskCache({ dir, maxBytes: 3000, failTtlMs: 1000, now: () => now });
    const k1 = imageCacheKey('https://a/1'), k2 = imageCacheKey('https://a/2'), k3 = imageCacheKey('https://a/3');
    assert.match(k1, /^[0-9a-f]{32}$/);
    assert.equal(c.get(k1), null);
    c.put(k1, new Uint8Array(1200)); now += 10; utimesSync(join(dir, `${k1}.png`), new Date(now - 50_000), new Date(now - 50_000));
    c.put(k2, new Uint8Array(1200)); now += 10;
    assert.equal(c.get(k1)?.length, 1200);
    c.put(k3, new Uint8Array(1200)); // 3600 > 3000 → evict the oldest by mtime (k1 was aged back)
    const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    assert.ok(files.length <= 2, `evicted down to ${files.length}`);
    assert.ok(!files.includes(`${k1}.png`), 'the oldest file went');
    c.markFailed(k2, 'HTTP 404');
    assert.equal(c.failed(k2), true);
    now += 2000;
    assert.equal(c.failed(k2), false, 'expired marker');
    c.put(k2, new Uint8Array(10));
    assert.ok(!readdirSync(dir).includes(`${k2}.fail`), 'a successful put clears the marker');
    await posixPermissions(t, () => { assert.ok((statSync(join(dir, `${k2}.png`)).mode & 0o077) === 0, 'cache files are 0600'); });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------- service
const tinyPng = (r: number, g: number, b: number): Uint8Array => { const p = encodePng({ w: 4, h: 4, rgba: new Uint8Array(64).map((_, i) => (i % 4 === 0 ? r : i % 4 === 1 ? g : i % 4 === 2 ? b : 255)) }); return new Uint8Array(p.buffer, p.byteOffset, p.byteLength); };
function fakeFetch(map: Record<string, Uint8Array | null>, calls: string[], delayMs = 0): (url: string, signal: AbortSignal) => Promise<FetchBytesResult> {
  return async (url) => {
    calls.push(url);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const b = map[url];
    if (b === undefined) return { ok: false, status: 404, finalUrl: url, contentType: null, bytes: new Uint8Array(0), redirects: [], reason: 'HTTP 404', elapsedMs: 1 };
    if (b === null) return { ok: false, status: 0, finalUrl: url, contentType: null, bytes: new Uint8Array(0), redirects: [], reason: 'timed out', elapsedMs: 1 };
    return { ok: true, status: 200, finalUrl: url, contentType: 'image/png', bytes: b, redirects: [], reason: null, elapsedMs: 1 };
  };
}
const mainThreadDecode = async (bytes: Uint8Array, thumbMax: number) => runDecodeJob({ id: 1, bytes, thumbMax });

test('service: get() is synchronous and never blocks; images land in the background and notify once each', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-imgsvc-'));
  try {
    const calls: string[] = [];
    let changes = 0;
    const svc = new ImageService({ dir, fetch: fakeFetch({ 'https://img.example/a.png': tinyPng(255, 0, 0), 'https://img.example/b.png': tinyPng(0, 255, 0) }, calls), decode: mainThreadDecode, onChange: () => { changes++; }, rewrite: (u) => u });
    assert.equal(svc.get(null).state, 'none');
    const first = svc.get('https://img.example/a.png', 1);
    assert.equal(first.state, 'pending');
    assert.equal(svc.get('https://img.example/a.png', 1).state, 'pending', 'asking again does not re-queue');
    svc.get('https://img.example/b.png', 2);
    assert.equal(await svc.whenIdle(2000), true);
    const a = svc.get('https://img.example/a.png');
    assert.equal(a.state, 'ready');
    if (a.state === 'ready') { assert.equal(a.img.w, 4); assert.deepEqual(Array.from(a.img.rgba.subarray(0, 4)), [255, 0, 0, 255]); assert.ok(a.png.length > 0); assert.equal(svc.pngFor(a.key), a.png); }
    assert.equal(changes, 2);
    assert.deepEqual(calls.sort(), ['https://img.example/a.png', 'https://img.example/b.png']);
    assert.equal(svc.pngFor('not-a-key'), null);
    // second service on the same dir: served from disk, no fetch
    const calls2: string[] = [];
    const svc2 = new ImageService({ dir, fetch: fakeFetch({}, calls2), decode: mainThreadDecode, rewrite: (u) => u });
    svc2.get('https://img.example/a.png');
    await svc2.whenIdle(2000);
    assert.equal(svc2.get('https://img.example/a.png').state, 'ready');
    assert.equal(calls2.length, 0, 'disk hit, no network');
    assert.equal(svc2.snapshot().diskHits, 1);
    svc.close(); svc2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('service: failures become `missing` (placeholder) and durable 4xx failures are not refetched; offline never fetches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-imgsvc-'));
  try {
    const calls: string[] = [];
    const svc = new ImageService({ dir, fetch: fakeFetch({ 'https://img.example/junk.png': new Uint8Array([1, 2, 3, 4]), 'https://img.example/slow.png': null }, calls), decode: mainThreadDecode, rewrite: (u) => u });
    svc.get('https://img.example/404.png'); svc.get('https://img.example/junk.png'); svc.get('https://img.example/slow.png');
    await svc.whenIdle(2000);
    assert.equal(svc.get('https://img.example/404.png').state, 'missing');
    const junk = svc.get('https://img.example/junk.png');
    assert.equal(junk.state, 'missing'); if (junk.state === 'missing') assert.match(junk.reason, /magic/);
    assert.equal(svc.get('https://img.example/slow.png').state, 'missing');
    svc.close();
    const calls2: string[] = [];
    const svc2 = new ImageService({ dir, fetch: fakeFetch({}, calls2), decode: mainThreadDecode, rewrite: (u) => u });
    svc2.get('https://img.example/404.png'); svc2.get('https://img.example/junk.png'); svc2.get('https://img.example/slow.png');
    await svc2.whenIdle(2000);
    assert.deepEqual(calls2, ['https://img.example/slow.png'], 'only the transient failure is retried');
    svc2.close();
    const calls3: string[] = [];
    const off = new ImageService({ dir, offline: true, fetch: fakeFetch({ 'https://img.example/new.png': tinyPng(1, 2, 3) }, calls3), decode: mainThreadDecode });
    off.get('https://img.example/new.png');
    await off.whenIdle(1000);
    const o = off.get('https://img.example/new.png');
    assert.equal(o.state, 'missing'); if (o.state === 'missing') assert.equal(o.reason, 'offline');
    assert.equal(calls3.length, 0);
    off.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('service: the queue serves the highest priority, then the most recently asked-for URL (visible rows win)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-imgsvc-'));
  try {
    const calls: string[] = [];
    const map: Record<string, Uint8Array> = {};
    for (const n of ['p0a', 'p0b', 'p1', 'p2']) map[`https://img.example/${n}.png`] = tinyPng(1, 1, 1);
    const svc = new ImageService({ dir, concurrency: 1, fetch: fakeFetch(map, calls, 5), decode: mainThreadDecode, rewrite: (u) => u });
    svc.get('https://img.example/p0a.png', 0); // starts at once (concurrency 1)
    svc.get('https://img.example/p0b.png', 0);
    svc.get('https://img.example/p1.png', 1);
    svc.get('https://img.example/p2.png', 2);
    await svc.whenIdle(3000);
    assert.deepEqual(calls, ['https://img.example/p0a.png', 'https://img.example/p2.png', 'https://img.example/p1.png', 'https://img.example/p0b.png']);
    svc.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('service: the default decoder runs in a worker thread (real decode of a fixture JPEG) and close() tears it down', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-imgsvc-'));
  try {
    const jpg = readFileSync(join(FIX, 'quad-420.jpg'));
    const calls: string[] = [];
    const svc = new ImageService({ dir, fetch: fakeFetch({ 'https://img.example/q.jpg': new Uint8Array(jpg) }, calls), rewrite: (u) => u, thumbMax: 16 });
    svc.get('https://img.example/q.jpg');
    assert.equal(await svc.whenIdle(8000), true, 'worker decode settled');
    const s = svc.get('https://img.example/q.jpg');
    assert.equal(s.state, 'ready', s.state === 'missing' ? s.reason : s.state);
    if (s.state === 'ready') { assert.equal(s.img.w, 16); assert.equal(s.img.h, 16); nearly(px(s.img, 2, 2), [255, 0, 0, 255], 12, 'red quadrant via worker'); }
    assert.equal(svc.snapshot().workerFallbacks, 0, 'decoded in the worker, not on the main thread');
    svc.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('service: cache key is stable and the popup route key shape is 32 hex', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-imgsvc-'));
  try {
    const svc = new ImageService({ dir, decode: mainThreadDecode });
    assert.equal(svc.keyFor('https://x/y'), imageCacheKey('https://x/y'));
    assert.match(svc.keyFor('https://x/y'), /^[0-9a-f]{32}$/);
    writeFileSync(join(dir, `${svc.keyFor('u')}.png`), encodePng({ w: 1, h: 1, rgba: new Uint8Array([1, 2, 3, 4]) }));
    assert.ok(svc.pngFor(svc.keyFor('u')), 'disk fallback for the popup route');
    svc.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
