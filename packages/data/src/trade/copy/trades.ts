// task-1360 Tier 1 — decode a followed wallet's swaps from its own transaction history (RawTx = the slim
// jsonParsed shape the wallet-intel rules already use; raw transactions are never stored).
//
// Per transaction the wallet's net token delta per mint (pre/post token balances for accounts it owns) and its
// net lamports delta (pre/post balances; fees and tips included) are read. One mint moved: tokens up and SOL
// down = BUY, tokens down and SOL up = SELL, tokens moved with no SOL leg = TRANSFER (airdrop / wallet move,
// flagged). Two or more mints moved (token→token) = both legs listed as a 'token-swap' with no SOL split, so
// nothing is priced that cannot be priced. Wrapped SOL is the swap's own plumbing and is never a "mint" here.

import { accountKeys } from '../../intel/rules.ts';
import type { RawTx } from '../../intel/rules.ts';
import { WSOL_MINT } from '../tx-decode.ts';
import type { WalletTrade } from './types.ts';

/** A SOL move below this is a fee/tip only, not a trade leg (0.0002 SOL). */
export const SOL_LEG_MIN_LAMPORTS = 200_000;

export interface DecodeOptions {
  /** SOL/USD at decode time (null = unpriced); recorded on the trade as `solUsdAt`. */
  solUsd?: number | null;
  /** When the node gave no block time (`t` unknown), use this (the fetch time). */
  fetchedAt?: number;
}

/** The wallet's net token delta per mint in one tx (raw base units), WSOL excluded. */
export function tokenDeltasForOwner(tx: RawTx, owner: string): Map<string, bigint> {
  const pre = new Map<number, { mint: string; amt: bigint }>();
  const post = new Map<number, { mint: string; amt: bigint }>();
  for (const b of tx.meta?.preTokenBalances ?? []) if (b.owner === owner && b.mint !== WSOL_MINT) pre.set(b.accountIndex, { mint: b.mint, amt: BigInt(b.uiTokenAmount.amount) });
  for (const b of tx.meta?.postTokenBalances ?? []) if (b.owner === owner && b.mint !== WSOL_MINT) post.set(b.accountIndex, { mint: b.mint, amt: BigInt(b.uiTokenAmount.amount) });
  const out = new Map<string, bigint>();
  for (const i of new Set([...pre.keys(), ...post.keys()])) {
    const mint = post.get(i)?.mint ?? pre.get(i)!.mint;
    const d = (post.get(i)?.amt ?? 0n) - (pre.get(i)?.amt ?? 0n);
    if (d !== 0n) out.set(mint, (out.get(mint) ?? 0n) + d);
  }
  return out;
}

/** The wallet's net lamports delta in one tx (fee included); 0 when the wallet is not an account key. */
export function lamportsDeltaFor(tx: RawTx, owner: string): number {
  const keys = accountKeys(tx);
  const i = keys.findIndex((k) => k.pubkey === owner);
  if (i < 0) return 0;
  const pre = tx.meta?.preBalances ?? [], post = tx.meta?.postBalances ?? [];
  return (post[i] ?? 0) - (pre[i] ?? 0);
}

/** Decode one transaction into the wallet's trades (0, 1 or several legs). Pure; never throws on odd input. */
export function decodeTx(tx: RawTx, wallet: string, opts: DecodeOptions = {}): WalletTrade[] {
  const sig = tx.transaction?.signatures?.[0] ?? '';
  const deltas = tokenDeltasForOwner(tx, wallet);
  if (deltas.size === 0) return [];
  const lamports = lamportsDeltaFor(tx, wallet);
  const tKnown = typeof tx.blockTime === 'number' && tx.blockTime > 0;
  const t = tKnown ? tx.blockTime! * 1000 : (opts.fetchedAt ?? 0);
  const solUsd = typeof opts.solUsd === 'number' && opts.solUsd > 0 ? opts.solUsd : null;
  const out: WalletTrade[] = [];
  const multi = deltas.size > 1;
  for (const [mint, delta] of deltas) {
    const solLeg = !multi && Math.abs(lamports) >= SOL_LEG_MIN_LAMPORTS;
    let side: WalletTrade['side'];
    let note: WalletTrade['note'] = null;
    if (multi) { side = delta > 0n ? 'buy' : 'sell'; note = 'token-swap'; }
    else if (delta > 0n && solLeg && lamports < 0) side = 'buy';
    else if (delta < 0n && solLeg && lamports > 0) side = 'sell';
    else if (solLeg) { side = 'transfer'; note = 'lp-like'; } // tokens AND SOL moved the same way: LP add/remove or a payout, not a swap
    else { side = 'transfer'; if (delta > 0n) note = 'airdrop'; }
    const solDelta = !multi && side !== 'transfer' ? lamports / 1e9 : null;
    const usd = solDelta !== null && solUsd !== null ? Math.abs(solDelta) * solUsd : null;
    out.push({ wallet, sig, slot: tx.slot, t, tKnown, mint, side, tokenDelta: delta.toString(), lamportsDelta: lamports, solDelta, usd, solUsdAt: solDelta !== null ? solUsd : null, note });
  }
  return out;
}

/** Decode a history page (any order) into trades sorted oldest first. */
export function decodeWalletTrades(txs: readonly RawTx[], wallet: string, opts: DecodeOptions = {}): WalletTrade[] {
  const out: WalletTrade[] = [];
  for (const tx of txs) out.push(...decodeTx(tx, wallet, opts));
  out.sort((a, b) => a.slot - b.slot || a.sig.localeCompare(b.sig));
  return out;
}
