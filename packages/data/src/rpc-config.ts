// RPC endpoint resolution (task-1298). The Helius key lives ONLY at ~/.dexterm/helius.key
// (mode 600, outside every repo). It is read here, in code, and the URL is built in memory.
// Nothing in this module logs, returns for display, or writes the key; `redactSecrets()`
// strips `api-key=<value>` from any string that might reach a log, an error, a recording
// or the screen, and every URL-bearing message in the data layer goes through it.
//
//   DEXTERM_RPC_URL   wins when set (any read-only JSON-RPC endpoint)
//   ~/.dexterm/helius.key   -> https://mainnet.helius-rpc.com/?api-key=<key>
//   otherwise         the public mainnet RPC (heavily throttled: holders usually unavailable)

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SOLANA_PUBLIC_RPC } from './sources/solana-rpc.ts';

export const HELIUS_RPC_HOST = 'mainnet.helius-rpc.com';
export const HELIUS_KEY_FILE = join('.dexterm', 'helius.key');

/**
 * Keyless public Solana RPCs added to the pool alongside the default endpoint (task-1309). These answer
 * `getAccountInfo` (mint/freeze authorities) without a key, so the authorities panel keeps working even
 * when the official endpoint is throttling. None of them reliably serve `getTokenLargestAccounts`
 * (the ranked holder list) keyless — that needs a free key — so the holders panel falls back to the
 * Jupiter aggregate (count + top-10 share). Probed live 2026-10-07; see the task-1309 handoff.
 */
export const PUBLIC_RPC_POOL: { url: string; label: string; basis: string }[] = [
  { url: SOLANA_PUBLIC_RPC, label: 'api.mainnet-beta.solana.com (public)', basis: 'official public RPC; getTokenLargestAccounts throttled per-IP' },
  { url: 'https://solana-rpc.publicnode.com', label: 'solana-rpc.publicnode.com (public)', basis: 'PublicNode keyless; serves getAccountInfo, blocks getTokenLargestAccounts' },
];

/**
 * What a free (user-supplied, no-card) key adds for each keyed capability, and how to get it in ~2 minutes.
 * Shown next to any "needs key" cell so the gap is honest and actionable (task-1309). No key is ever shipped.
 */
export const FREE_KEY_GUIDANCE: Record<string, { adds: string; how: string }> = {
  'top-holders': {
    adds: 'the ranked top-20 holder list with owner wallets (keyless you still get holder count + top-10 % via Jupiter)',
    how: 'free Helius key → ~/.dexterm/helius.key, or any free RPC URL in DEXTERM_RPC_URL (Alchemy/QuickNode/Ankr free tier)',
  },
  forensics: {
    adds: 'snipers, bundled-buy %, and creator dev-history (prior launches / rugs)',
    how: 'free Helius key (1M credits/mo, no card) → ~/.dexterm/helius.key, or a Solana Tracker key → ~/.dexterm/solanatracker.key',
  },
  'dev-history': {
    adds: "the creator's prior launches and rug record",
    how: 'free Helius key → ~/.dexterm/helius.key (Jupiter also gives a partial dev flag keyless)',
  },
  'live-tape': {
    adds: 'richer, wallet-labelled trade flow (keyless you get the GeckoTerminal tape)',
    how: 'free Helius key → ~/.dexterm/helius.key',
  },
};

/** The public mainnet RPC WebSocket (keyless), for the fast lane's accountSubscribe fallback. */
export const SOLANA_PUBLIC_RPC_WS = 'wss://api.mainnet-beta.solana.com';

/**
 * WebSocket URL for an RPC HTTP endpoint (http→ws, https→wss), preserving any `?api-key=` query so the
 * same key authenticates the stream. Never log the result (it may carry a key); pass through redactSecrets.
 * Returns null when the URL is unparseable.
 */
export function wsUrlFor(httpUrl: string): string | null {
  try {
    const u = new URL(httpUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : u.protocol === 'http:' ? 'ws:' : u.protocol;
    return u.toString();
  } catch {
    return null;
  }
}

/** Extra user-supplied free RPC endpoints, from DEXTERM_RPC_URLS (comma-separated, read-only). */
export function extraRpcUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.DEXTERM_RPC_URLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && isLikelyUrl(s));
}

function isLikelyUrl(s: string): boolean {
  try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; }
}

export type RpcProvider = 'helius' | 'custom' | 'public';

export interface RpcConfig {
  /** The URL to call. May contain a secret: never print it, pass it to redactSecrets() first. */
  url: string;
  provider: RpcProvider;
  /** Where the configuration came from, safe to print. */
  basis: 'env DEXTERM_RPC_URL' | '~/.dexterm/helius.key' | 'public mainnet (no key)';
  /** Public RPC to fall back to when the configured endpoint fails (null when it is the public one). */
  fallbackUrl: string | null;
}

export interface ResolveRpcOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Injectable for tests; default reads the file. */
  readFile?: (path: string) => string;
}

/** Resolve the RPC endpoint. Never throws: a missing or unreadable key file means the public RPC. */
export function resolveRpcUrl(opts: ResolveRpcOptions = {}): RpcConfig {
  const env = opts.env ?? process.env;
  const fromEnv = env.DEXTERM_RPC_URL?.trim();
  if (fromEnv) {
    let provider: RpcProvider = 'custom';
    try { if (new URL(fromEnv).hostname === HELIUS_RPC_HOST) provider = 'helius'; } catch { /* keep custom */ }
    return { url: fromEnv, provider, basis: 'env DEXTERM_RPC_URL', fallbackUrl: SOLANA_PUBLIC_RPC };
  }
  const path = join(opts.home ?? homedir(), HELIUS_KEY_FILE);
  let key = '';
  try {
    key = (opts.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(path).trim();
  } catch {
    key = '';
  }
  if (key && isPlausibleKey(key)) {
    return { url: `https://${HELIUS_RPC_HOST}/?api-key=${encodeURIComponent(key)}`, provider: 'helius', basis: '~/.dexterm/helius.key', fallbackUrl: SOLANA_PUBLIC_RPC };
  }
  return { url: SOLANA_PUBLIC_RPC, provider: 'public', basis: 'public mainnet (no key)', fallbackUrl: null };
}

/** A key is one token of URL-safe characters; anything else (a pasted sentence, a blank file) is ignored. */
export function isPlausibleKey(key: string): boolean {
  return /^[A-Za-z0-9._~-]{8,128}$/.test(key);
}

const API_KEY_RE = /([?&](?:api[-_]?key|apikey|key|token)=)[^&\s"'<>]*/gi;

/** Replace the value of any `api-key=` style query parameter with `REDACTED`. Safe on any string. */
export function redactSecrets(text: string): string {
  return text.replace(API_KEY_RE, '$1REDACTED');
}

/** True when `text` still carries an api-key value other than the REDACTED marker (self-check before writing files). */
export function containsSecret(text: string): boolean {
  API_KEY_RE.lastIndex = 0;
  for (const m of text.matchAll(API_KEY_RE)) {
    const value = m[0].slice(m[1].length);
    if (value && value !== 'REDACTED') return true;
  }
  return false;
}
