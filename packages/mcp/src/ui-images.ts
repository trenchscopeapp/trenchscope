import { fetchBytes, thumbnailUrl, sniffFormat, decodeThumbnail, encodePng, checkDims, DEFAULT_LIMITS, type DataLayer } from '@dexterm/data';

export function rasterDataUrl(bytes: Uint8Array): string | null {
  try {
    const format = sniffFormat(bytes);
    if (!format) return null;
    if (format !== 'webp') {
      const thumbnail = decodeThumbnail(bytes, 64);
      return `data:image/png;base64,${encodePng(thumbnail).toString('base64')}`;
    }
    // Browser-native WebP avoids adding a decoder dependency. Bound canvas/frame dimensions first.
    const buffer = Buffer.from(bytes);
    if (buffer.length < 30 || buffer.length > 96 * 1024) return null;
    let width = 0, height = 0;
    const kind = buffer.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      if (buffer[20] & 2) return null; // Animated images can have unbounded decoded frame counts.
      width = buffer.readUIntLE(24, 3) + 1; height = buffer.readUIntLE(27, 3) + 1;
    } else if (kind === 'VP8L' && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (kind === 'VP8 ' && buffer[23] === 0x9d && buffer[24] === 1 && buffer[25] === 0x2a) {
      width = buffer.readUInt16LE(26) & 0x3fff; height = buffer.readUInt16LE(28) & 0x3fff;
    } else return null;
    checkDims(width, height, DEFAULT_LIMITS, 'webp');
    return `data:image/webp;base64,${buffer.toString('base64')}`;
  } catch { return null; }
}

/** Embed capped raster bytes in app-only metadata. No third-party image origins needed in Claude's CSP. */
export async function loadUiImages(result: Record<string, unknown>, data: DataLayer): Promise<Record<string, string>> {
  const rows = Array.isArray(result.rows) ? result.rows as Array<{ mint?: string }> : null;
  let tokens: Array<{ mint: string; image?: unknown }>;
  if (rows) {
    const mints = rows.map((row) => row.mint).filter((mint): mint is string => typeof mint === 'string').slice(0, 50);
    if (!mints.length) return {};
    tokens = (await data.store.enrich(mints, { price: false })).rows.map((row) => ({ mint: row.mint, image: row.token.image }));
  } else {
    const market = (result.market ?? result) as { token?: { mint: string; image?: unknown } };
    tokens = market.token ? [market.token] : [];
  }
  const images: Record<string, string> = {};
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, tokens.length) }, async () => {
    while (next < tokens.length) {
      const token = tokens[next++];
      if (typeof token.image !== 'string') continue;
      const url = thumbnailUrl(token.image, 64);
      const key = url.slice(0, 2048);
      const cached = data.cache.get<string | null>('mcp:images', key);
      if (cached && !cached.stale) { if (cached.value) images[token.mint] = cached.value; continue; }
      const fetched = await fetchBytes(url, { maxBytes: 96 * 1024, timeoutMs: 2000, maxRedirects: 2, accept: 'image/png,image/jpeg,image/webp,image/gif' });
      const image = fetched.ok ? rasterDataUrl(fetched.bytes) : null;
      data.cache.set('mcp:images', key, image, { ttlMs: image ? 3600_000 : 60_000 });
      if (image) images[token.mint] = image;
    }
  }));
  return images;
}
