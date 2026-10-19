import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePng } from '@dexterm/data';
import { rasterDataUrl } from '../src/ui-images.ts';

test('MCP App accepts bounded raster thumbnails and refuses SVG and oversized dimensions', () => {
  const png = encodePng({ w: 1, h: 1, rgba: new Uint8Array([1, 2, 3, 255]) });
  assert.match(rasterDataUrl(png)!, /^data:image\/png;base64,/);
  assert.equal(rasterDataUrl(Buffer.from('<svg onload="alert(1)"/>')), null);
  const giant = Buffer.from(png); giant.writeUInt32BE(100000, 16);
  assert.equal(rasterDataUrl(giant), null);
  const webp = Buffer.alloc(30); webp.write('RIFF', 0); webp.write('WEBP', 8); webp.write('VP8X', 12); webp.writeUIntLE(100000, 24, 3);
  assert.equal(rasterDataUrl(webp), null);
  webp.writeUIntLE(63, 24, 3); webp.writeUIntLE(63, 27, 3);
  assert.match(rasterDataUrl(webp)!, /^data:image\/webp;base64,/);
  webp[20] = 2; assert.equal(rasterDataUrl(webp), null);
});
