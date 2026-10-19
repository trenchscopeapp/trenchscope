// @dexterm/data — "paste a CA or a coin link anywhere" (task-1401, building on the task-1388 GO-TO parser). Shared by
// the CLI (go-to prompt, analyst chat, the screener `/` line, --mint) and the MCP server (a link passed as `mint`).
//
// parseMintTarget (task-1388) pulls a base58 mint out of a bare address or a dexscreener / pump.fun / solscan URL.
// parseCoinTarget adds what the other inputs need: WHICH site the link came from (a dexscreener.com/solana/<addr>
// link usually names the POOL, so it is resolved to its coin before the token screen opens) and the REST of the
// text, so "is <CA> a rug?" in the analyst chat opens the coin and asks the question about it.
// Pure and total: never throws, only ever returns a validated base58 string.

import type { DataLayer } from './index.ts';

/** A full base58 Solana mint: 32–44 chars, no 0/O/I/l. Same shape `--mint` validates. */
export const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * task-1388: turn a pasted/typed go-to target into a mint, or null when there is none. Accepts a bare base58
 * mint, or a dexscreener / pump.fun / solscan URL (or any text) by pulling the first base58 run of mint length.
 * Base58 excludes 0, O, I and l, so splitting on every non-base58 character also splits on them and on the URL
 * punctuation (/, :, ., ?, =, &), leaving each path/query segment as its own token; a real mint is never cut.
 */
export function parseMintTarget(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (MINT_RE.test(s)) return s;
  for (const tok of s.split(/[^1-9A-HJ-NP-Za-km-z]+/)) if (MINT_RE.test(tok)) return tok;
  return null;
}

export type CoinVia = 'address' | 'dexscreener' | 'pumpfun' | 'solscan' | 'birdeye' | 'link';

export interface CoinTarget {
  /** The base58 address found (a mint, or for `dexscreener` possibly a pool address). */
  address: string;
  via: CoinVia;
  /** The input with the address / link removed (a question to ask about the coin, or ''). */
  rest: string;
}

const HOSTS: Array<[RegExp, CoinVia]> = [
  [/(^|\.)dexscreener\.com$/, 'dexscreener'],
  [/(^|\.)pump\.fun$/, 'pumpfun'],
  [/(^|\.)solscan\.io$/, 'solscan'],
  [/(^|\.)birdeye\.so$/, 'birdeye'],
];
const URLISH = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(\/\S*)$/i;

/**
 * Find the first coin address in free text: a link with an address in its path (its host decides `via`), else a
 * bare base58 address word. `rest` is the remaining text. Null when the text names no address.
 */
export function parseCoinTarget(raw: string): CoinTarget | null {
  const s = String(raw ?? '').trim().slice(0, 800);
  if (!s) return null;
  const words = s.split(/\s+/);
  const restWithout = (i: number): string => words.filter((_, k) => k !== i).join(' ').trim();
  for (let i = 0; i < words.length; i++) {
    const m = URLISH.exec(words[i]);
    if (!m) continue;
    const address = parseMintTarget(m[2]);
    if (!address) continue;
    const host = m[1].toLowerCase();
    return { address, via: HOSTS.find(([re]) => re.test(host))?.[1] ?? 'link', rest: restWithout(i) };
  }
  for (let i = 0; i < words.length; i++) {
    // a bare address, allowing surrounding punctuation ("<CA>?", "(CA)", "CA,")
    const core = words[i].replace(/^[^1-9A-HJ-NP-Za-km-z]+|[^1-9A-HJ-NP-Za-km-z]+$/g, '');
    if (MINT_RE.test(core)) return { address: core, via: 'address', rest: restWithout(i) };
  }
  return null;
}

/** True when the text left after the address asks nothing ("", "open", "check this", "?"): just open the coin. */
export function isBareOpen(rest: string): boolean {
  return /^(?:(?:open|go|to|show|me|check|look|at|this|that|one|the|ca|token|coin|pls|please|here|it)\b|[\s?.!:,;\-–—])*$/i.test(rest.trim());
}

/**
 * Resolve a target to the coin's mint. A dexscreener link's address is looked up as a pair first (one keyless
 * request through the limiter); when DexScreener has no such pair, or the lookup fails (offline, a replay without
 * it), the address is used as the mint. Every other target is already a mint.
 */
export async function resolveCoinTarget(t: CoinTarget, dl: Pick<DataLayer, 'dexscreener'> | null): Promise<{ mint: string; fromPair: boolean }> {
  if (t.via !== 'dexscreener' || !dl) return { mint: t.address, fromPair: false };
  try {
    const coin = await dl.dexscreener.pairCoin(t.address);
    if (coin && MINT_RE.test(coin)) return { mint: coin, fromPair: coin !== t.address };
  } catch { /* fall through: treat the address as the mint */ }
  return { mint: t.address, fromPair: false };
}
