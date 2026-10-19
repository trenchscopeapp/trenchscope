// trenchscope — coin-image settings (task-1326). Three layers, strongest last: the file ~/.dexterm/images.json
// (DEXTERM_HOME overrides the directory, same as popup.json / state.json), the DEXTERM_IMAGES environment
// variable, and the --no-images flag. A missing or malformed file degrades to the defaults and never throws.
//
//   images.json: { "enabled": true, "blocks": "half" | "quad", "protocol": "auto" | "kitty" | "iterm" | "sixel" | "blocks",
//                  "thumbMax": 96, "diskMb": 32, "replay": false }
//   DEXTERM_IMAGES=0|off|false   images off      DEXTERM_IMAGES=kitty|iterm|sixel|blocks   force a protocol
//   A --replay / DEXTERM_OFFLINE run has no network, so images there could only come from the disk cache: they stay
//   OFF unless `replay: true` in the file or DEXTERM_IMAGES says on — recordings keep rendering exactly as recorded.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dextermHome } from './boot-state.ts';
import type { ImageProtocol, BlockMode } from '@dexterm/tui';

export interface ImagesConfig {
  enabled: boolean;
  /** Fallback renderer for the token-header hero (list icons always use `quad`). */
  blocks: BlockMode;
  protocol: 'auto' | ImageProtocol;
  /** Longest thumbnail side cached on disk / sent to the terminal. */
  thumbMax: number;
  /** Disk cache cap in MiB. */
  diskMb: number;
  /** Show images (from the cache only) in --replay / offline runs too. */
  replay: boolean;
  source: 'defaults' | 'file';
}

export const DEFAULT_IMAGES_CONFIG: ImagesConfig = { enabled: true, blocks: 'half', protocol: 'auto', thumbMax: 96, diskMb: 32, replay: false, source: 'defaults' };

export function imagesConfigPath(env: NodeJS.ProcessEnv = process.env): string { return join(dextermHome(env), 'images.json'); }

export function normalizeImagesConfig(raw: unknown, source: ImagesConfig['source'] = 'file'): ImagesConfig {
  const o = (raw && typeof raw === 'object' ? raw as Record<string, unknown> : {});
  const num = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
  const protocol = typeof o.protocol === 'string' && ['auto', 'kitty', 'iterm', 'sixel', 'blocks'].includes(o.protocol) ? (o.protocol as ImagesConfig['protocol']) : 'auto';
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : true,
    blocks: o.blocks === 'quad' ? 'quad' : 'half',
    protocol,
    thumbMax: Math.round(num(o.thumbMax, 32, 192, DEFAULT_IMAGES_CONFIG.thumbMax)),
    diskMb: Math.round(num(o.diskMb, 4, 512, DEFAULT_IMAGES_CONFIG.diskMb)),
    replay: o.replay === true,
    source,
  };
}

/** The file's settings, or the defaults. Never throws. */
export function loadImagesConfig(env: NodeJS.ProcessEnv = process.env): ImagesConfig {
  try { return normalizeImagesConfig(JSON.parse(readFileSync(imagesConfigPath(env), 'utf8')), 'file'); }
  catch { return { ...DEFAULT_IMAGES_CONFIG }; }
}

/** File → env → flag. `noImagesFlag` is `--no-images`; `offline` = a --replay / DEXTERM_OFFLINE run (cache only). */
export function resolveImagesConfig(env: NodeJS.ProcessEnv, noImagesFlag: boolean, opts: { offline?: boolean; file?: ImagesConfig } = {}): ImagesConfig {
  const out = { ...(opts.file ?? loadImagesConfig(env)) };
  const e = (env.DEXTERM_IMAGES || '').trim().toLowerCase();
  let explicitOn = false;
  if (e === '0' || e === 'off' || e === 'false' || e === 'no') out.enabled = false;
  else if (e === '1' || e === 'on' || e === 'true' || e === 'yes') { out.enabled = true; explicitOn = true; }
  else if (e === 'kitty' || e === 'iterm' || e === 'sixel' || e === 'blocks') { out.enabled = true; out.protocol = e; explicitOn = true; }
  if (opts.offline && !out.replay && !explicitOn) out.enabled = false;
  if (noImagesFlag) out.enabled = false;
  return out;
}
