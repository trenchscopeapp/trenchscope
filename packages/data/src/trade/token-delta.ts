// trenchscope T1/T2 — task-1337: the TOKEN-BALANCE DIFF (the round-3 verifier's "recommended next hardening").
//
// The static policy fixes WHICH instructions a transaction may carry and binds the one Jupiter route to the
// plan (amounts, the wallet's own token accounts, no fee). What it cannot see is what the route DOES once
// it runs: a legit-looking route instruction whose `route_plan` names crafted pool accounts could, if the
// on-chain program ever let it, move tokens out of one of the wallet's OTHER token accounts. The SOL-delta
// check would not notice (only the fee leaves the wallet in SOL). This module is the backstop: simulate
// with the wallet's token accounts in `accounts[]` and refuse when any of them lost tokens the plan does
// not spend.
//
//   buy  (SOL → token): NO token account of the wallet may decrease.
//   sell (token → SOL): ONLY the wallet's token accounts for the ORDER mint may decrease, by at most the
//                       order amount in total. Everything else must not decrease.
//   wrapped SOL:        the wallet's WSOL accounts ARE watched (task-1337 F2). A swap funds, syncs and
//                       closes a wrapped-SOL account back to the wallet, so WSOL leaving the wallet is
//                       SOL-value out — not a free pass. `checkTokenDeltas` tallies how much wrapped SOL
//                       left (`wsolLost`); the executor bounds `solOut + wsolLost` against the plan's SOL
//                       leg (`checkWsolBound`), so a route that drains a PRE-EXISTING WSOL account is
//                       caught by the SOL-value budget instead of being ignored.
//
// One simulation can carry only so many token accounts (`MAX_TOKEN_WATCH`). A referenced account is NEVER
// dropped to fit that cap (task-1337 F3): `buildTokenWatch` keeps every referenced account and bounds only
// the unreferenced tail, and the executor refuses outright (`referencedOverCap`) when the transaction
// references more wallet token accounts than one simulation can hold.
//
// Pure: no I/O here. The executor fetches the pre-state (getTokenAccountsByOwner / getMultipleAccounts),
// resolves address-lookup tables so "referenced by the transaction" is exact for v0 messages, asks the
// simulation for the post-state and hands both to `checkTokenDeltas`. Unknowable = refuse (fail closed).

import { base58 } from '../sources/solana-rpc.ts';
import type { AccountInfo } from './rpc-exec.ts';
import { WSOL_MINT, type DecodedTransaction } from './tx-decode.ts';

/** SPL Token / Token-2022 account base layout: mint[0..32] owner[32..64] amount u64 LE [64..72] state[108]. */
export const TOKEN_ACCOUNT_LEN = 165;

export interface TokenAccountState { mint: string; owner: string; amount: bigint }

/** Parse an SPL token account (both programs share the 165-byte base layout; Token-2022 may append extensions). */
export function parseTokenAccount(data: Buffer | null | undefined): TokenAccountState | null {
  if (!data || data.length < TOKEN_ACCOUNT_LEN) return null;
  if (data[108] === 0) return null; // AccountState::Uninitialized
  return { mint: base58(data.subarray(0, 32)), owner: base58(data.subarray(32, 64)), amount: data.readBigUInt64LE(64) };
}

/** One of the wallet's token accounts, as the executor watches it through the simulation. */
export interface TokenWatch {
  address: string;
  mint: string;
  /** Balance BEFORE the transaction (base units). */
  pre: bigint;
  /** Is the account named by the transaction (static key or loaded from a lookup table)? */
  referenced: boolean;
  /** Wrapped-SOL account (mint = WSOL): its loss is SOL-value out, bounded by `checkWsolBound`, not a
   *  per-account token refusal. task-1337 F2. */
  isWsol?: boolean;
}

/** Address-lookup-table account layout: 56-byte LookupTableMeta, then 32-byte addresses. */
export const LOOKUP_TABLE_META_LEN = 56;

export function parseLookupTable(data: Buffer | null | undefined): string[] | null {
  if (!data || data.length < LOOKUP_TABLE_META_LEN) return null;
  const body = data.subarray(LOOKUP_TABLE_META_LEN);
  if (body.length % 32 !== 0) return null;
  const out: string[] = [];
  for (let i = 0; i < body.length; i += 32) out.push(base58(body.subarray(i, i + 32)));
  return out;
}

/**
 * Every account a transaction can touch: its static keys plus the lookup-table entries it loads.
 * `tables` maps a table address → its parsed address list. A table the caller could not read, or an
 * index past the table's end, makes the set UNKNOWABLE → null (the executor refuses, fail closed).
 */
export function referencedAccounts(tx: DecodedTransaction, tables: ReadonlyMap<string, string[]>): Set<string> | null {
  const out = new Set(tx.staticKeys);
  for (const l of tx.lookups) {
    const t = tables.get(l.table);
    if (!t) return null;
    for (const i of [...l.writable, ...l.readonly]) {
      if (i < 0 || i >= t.length) return null;
      out.add(t[i]);
    }
  }
  return out;
}

/** Build the watch list from the wallet's token accounts (pre-state) and the transaction's account set. */
export function buildTokenWatch(user: string, accounts: { pubkey: string; data: Buffer }[], referenced: ReadonlySet<string>, opts: { max?: number } = {}): TokenWatch[] {
  const seen = new Set<string>();
  const all: TokenWatch[] = [];
  for (const a of accounts) {
    if (seen.has(a.pubkey)) continue;
    const st = parseTokenAccount(a.data);
    if (!st || st.owner !== user) continue;
    seen.add(a.pubkey);
    // task-1337 F2: wrapped SOL is watched too (its loss is SOL-value out, bounded by checkWsolBound).
    all.push({ address: a.pubkey, mint: st.mint, pre: st.amount, referenced: referenced.has(a.pubkey), isWsol: st.mint === WSOL_MINT });
  }
  // task-1337 F3: a referenced account can be touched by the transaction, so it must NEVER be dropped to
  // fit the cap. Keep every referenced account; bound only the unreferenced tail (largest balances first).
  // When referenced accounts alone exceed the cap the list exceeds it on purpose and the executor refuses
  // (see `referencedOverCap`) — truncating them here would hide a drain of a dropped account.
  const max = opts.max ?? MAX_TOKEN_WATCH;
  const ref = all.filter((w) => w.referenced).sort(byBalance);
  const unref = all.filter((w) => !w.referenced).sort(byBalance);
  return [...ref, ...unref.slice(0, Math.max(0, max - ref.length))];
}

function byBalance(x: TokenWatch, y: TokenWatch): number { return y.pre > x.pre ? 1 : y.pre < x.pre ? -1 : 0; }

/** How many token accounts ride along in one simulateTransaction `accounts[]` (plus the wallet itself). */
export const MAX_TOKEN_WATCH = 48;

/**
 * task-1337 F3: does the transaction reference MORE of the wallet's own token accounts than one simulation
 * can carry? If so the watch list cannot cover them all and the executor must refuse (fail closed) rather
 * than silently drop referenced accounts. Counts only referenced accounts (the unreferenced tail is
 * bounded safely by `buildTokenWatch`).
 */
export function referencedOverCap(watch: readonly TokenWatch[], max = MAX_TOKEN_WATCH): boolean {
  let n = 0;
  for (const w of watch) if (w.referenced) n++;
  return n > max;
}

export type TokenDeltaResult =
  | {
      ok: true;
      /** Base units spent from the order mint's accounts (a sell). */
      spent: bigint;
      /** Lamports of pre-existing wrapped SOL that left the wallet (task-1337 F2); bounded by checkWsolBound. */
      wsolLost: bigint;
      checked: number;
    }
  | { ok: false; reason: 'token-delta' | 'token-delta-unknown'; message: string };

/**
 * The decision. `post` maps a watched address → its post-simulation balance, or null when the node
 * returned no account for it (closed, or — for an account the transaction never references — simply
 * not loaded: such an account cannot have changed, so it keeps its pre-balance). An account the
 * transaction DOES reference and that comes back null was closed: a positive pre-balance then counts
 * as fully drained. A watched account missing from `post` entirely (the node sent no data) is
 * unknowable → refused when it held anything.
 */
export function checkTokenDeltas(
  side: 'buy' | 'sell', orderMint: string, amountRaw: bigint,
  watch: readonly TokenWatch[], post: ReadonlyMap<string, bigint | null> | null,
): TokenDeltaResult {
  let spent = 0n;
  let wsolLost = 0n;
  let checked = 0;
  for (const w of watch) {
    if (post === null || !post.has(w.address)) {
      if (w.pre > 0n) return { ok: false, reason: 'token-delta-unknown', message: `the simulation did not report the post-balance of the wallet's ${short(w.mint)} token account ${short(w.address)}` };
      continue;
    }
    checked++;
    const raw = post.get(w.address) ?? null;
    const after = raw === null ? (w.referenced ? 0n : w.pre) : raw;
    if (w.isWsol) {
      // task-1337 F2: wrapped SOL is SOL-value, not a token holding. A legit wrap/sync/close returns it to
      // the wallet as native SOL. Only tally what left; the combined SOL-value bound lives in the executor
      // (checkWsolBound), where the plan's SOL leg and the native SOL delta are known.
      if (after < w.pre) wsolLost += w.pre - after;
      continue;
    }
    if (after >= w.pre) continue;
    const lost = w.pre - after;
    if (side === 'sell' && w.mint === orderMint) {
      spent += lost;
      if (spent > amountRaw) return { ok: false, reason: 'token-delta', message: `the simulation spends ${spent} base units of ${short(orderMint)} but the order is ${amountRaw}` };
      continue;
    }
    return { ok: false, reason: 'token-delta', message: `the simulation moves ${lost} base units of ${short(w.mint)} out of the wallet's token account ${short(w.address)}, which this ${side} does not spend` };
  }
  return { ok: true, spent, wsolLost, checked };
}

export type WsolBoundResult = { ok: true } | { ok: false; reason: 'wsol-drain'; message: string };

/**
 * task-1337 F2: pre-existing wrapped SOL that leaves the wallet is SOL-value out and must fit the plan.
 *   buy:  native SOL out + wrapped SOL consumed may be at most the planned SOL leg plus the fee allowance
 *         (wrapping is fungible, so the two are one budget). A null native delta with WSOL gone is
 *         unmeasurable → refuse.
 *   sell: a sell RECEIVES SOL, so its own WSOL accounts must not shrink by more than fee dust — the
 *         incoming proceeds must never mask a drain, so the native delta is not credited here.
 * `wsolLost <= 0` is the overwhelmingly common case (no pre-existing WSOL touched) → pass cheaply.
 */
export function checkWsolBound(
  side: 'buy' | 'sell', solOut: bigint | null, wsolLost: bigint, solLegLamports: bigint, allowanceLamports: bigint,
): WsolBoundResult {
  if (wsolLost <= 0n) return { ok: true };
  if (side === 'buy') {
    if (solOut === null) return { ok: false, reason: 'wsol-drain', message: `the simulation removes ${wsolLost} lamports of pre-existing wrapped SOL but the native SOL delta is unknown` };
    const out = solOut + wsolLost;
    const limit = solLegLamports + allowanceLamports;
    if (out > limit) return { ok: false, reason: 'wsol-drain', message: `the simulation removes ${wsolLost} lamports of wrapped SOL plus ${solOut} native lamports (${out} total) but the plan's SOL leg is ${solLegLamports} (+${allowanceLamports} allowance)` };
    return { ok: true };
  }
  if (wsolLost > allowanceLamports) return { ok: false, reason: 'wsol-drain', message: `a sell removes ${wsolLost} lamports of pre-existing wrapped SOL from the wallet, beyond the ${allowanceLamports}-lamport fee allowance` };
  return { ok: true };
}

/** Post-simulation balances for the watched accounts from `simulate(..., { accounts: [user, ...watch] })`. */
export function postBalances(watch: readonly TokenWatch[], accountsData: (Buffer | null)[] | null, offset: number): Map<string, bigint | null> | null {
  if (accountsData === null) return null;
  const out = new Map<string, bigint | null>();
  for (let i = 0; i < watch.length; i++) {
    const d = accountsData[offset + i];
    if (d === undefined) return null; // the node answered for fewer accounts than asked → unknowable
    out.set(watch[i].address, d === null ? null : (parseTokenAccount(d)?.amount ?? 0n));
  }
  return out;
}

/** Refresh the pre-balances of an existing watch list from fresh account snapshots (the confirm step). */
export function refreshWatch(watch: readonly TokenWatch[], infos: (AccountInfo | null)[]): TokenWatch[] | null {
  if (infos.length !== watch.length) return null;
  return watch.map((w, i) => {
    const st = parseTokenAccount(infos[i]?.data);
    return { ...w, pre: st ? st.amount : 0n };
  });
}

function short(k: string): string { return k.length > 12 ? `${k.slice(0, 4)}…${k.slice(-4)}` : k; }
