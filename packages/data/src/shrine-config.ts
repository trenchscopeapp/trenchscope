// Shrine key (optional, keyed source: 1-second candles over socket.io). The key lives ONLY at
// ~/.dexterm/shrine.key (or DEXTERM_SHRINE_KEY for a one-off run). It is sent only inside the socket.io
// CONNECT auth payload after the socket opens, never in a URL, so recordings, logs and error text never
// carry it. Never print the value.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isPlausibleKey } from './rpc-config.ts';

export const SHRINE_KEY_FILE = join('.dexterm', 'shrine.key');

export interface ResolveShrineOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  readFile?: (path: string) => string;
}

export interface ShrineKey {
  key: string;
  basis: 'env DEXTERM_SHRINE_KEY' | '~/.dexterm/shrine.key';
}

/** The Shrine key, or null. Never throws: a missing, unreadable or implausible key means "no key". */
export function resolveShrineKey(opts: ResolveShrineOptions = {}): ShrineKey | null {
  const env = opts.env ?? process.env;
  const fromEnv = env.DEXTERM_SHRINE_KEY?.trim();
  if (fromEnv && isPlausibleKey(fromEnv)) return { key: fromEnv, basis: 'env DEXTERM_SHRINE_KEY' };
  let key = '';
  try {
    key = (opts.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(join(opts.home ?? homedir(), SHRINE_KEY_FILE)).trim();
  } catch {
    key = '';
  }
  return key && isPlausibleKey(key) ? { key, basis: '~/.dexterm/shrine.key' } : null;
}
