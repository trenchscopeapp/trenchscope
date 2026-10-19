// Solana Tracker key (optional, keyed source). The key lives ONLY at ~/.dexterm/solanatracker.key
// (or DEXTERM_SOLANATRACKER_KEY for a one-off run). It is sent as the `x-api-key` request header, never in a
// URL, so recordings (method + URL only), logs and error text never carry it. Never print the value.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isPlausibleKey } from './rpc-config.ts';

export const TRACKER_KEY_FILE = join('.dexterm', 'solanatracker.key');

export interface ResolveTrackerOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  readFile?: (path: string) => string;
}

export interface TrackerKey {
  key: string;
  basis: 'env DEXTERM_SOLANATRACKER_KEY' | '~/.dexterm/solanatracker.key';
}

/** The Solana Tracker key, or null. Never throws: a missing, unreadable or implausible key means "no key". */
export function resolveTrackerKey(opts: ResolveTrackerOptions = {}): TrackerKey | null {
  const env = opts.env ?? process.env;
  const fromEnv = env.DEXTERM_SOLANATRACKER_KEY?.trim();
  if (fromEnv && isPlausibleKey(fromEnv)) return { key: fromEnv, basis: 'env DEXTERM_SOLANATRACKER_KEY' };
  let key = '';
  try {
    key = (opts.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(join(opts.home ?? homedir(), TRACKER_KEY_FILE)).trim();
  } catch {
    key = '';
  }
  return key && isPlausibleKey(key) ? { key, basis: '~/.dexterm/solanatracker.key' } : null;
}
