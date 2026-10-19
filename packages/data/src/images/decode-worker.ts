// @dexterm/data — worker-thread entry for coin-image decoding (task-1326). Decoding a 800×800 PNG or a
// baseline JPEG takes 5–60 ms of pure JS; on the render thread that is one to two dropped frames per
// image at 30 fps, so the ImageService runs the decode + thumbnail + PNG re-encode here and only ever
// receives small transferable buffers back. Anything thrown (hostile bytes, caps) comes back as a message.
import { parentPort } from 'node:worker_threads';
import { decodeThumbnail } from './decode.ts';
import { encodePng } from './png.ts';

export interface DecodeJob { id: number; bytes: Uint8Array; thumbMax: number }
export type DecodeReply =
  | { id: number; ok: true; w: number; h: number; rgba: Uint8Array; png: Uint8Array; format: string; srcW: number; srcH: number }
  | { id: number; ok: false; error: string };

/** Pure job runner (also used by the main-thread fallback). */
export function runDecodeJob(job: DecodeJob): DecodeReply {
  try {
    const d = decodeThumbnail(job.bytes, job.thumbMax);
    const png = encodePng({ w: d.w, h: d.h, rgba: d.rgba });
    // own copies: a pooled Buffer slab and a subarray view are not transferable across the worker boundary
    return { id: job.id, ok: true, w: d.w, h: d.h, rgba: new Uint8Array(d.rgba), png: new Uint8Array(png), format: d.format, srcW: d.srcW, srcH: d.srcH };
  } catch (e) {
    return { id: job.id, ok: false, error: (e as Error).message ?? String(e) };
  }
}

if (parentPort) {
  parentPort.on('message', (job: DecodeJob) => {
    const r = runDecodeJob(job);
    if (r.ok) parentPort!.postMessage(r, [r.rgba.buffer as ArrayBuffer, r.png.buffer as ArrayBuffer]);
    else parentPort!.postMessage(r);
  });
}
