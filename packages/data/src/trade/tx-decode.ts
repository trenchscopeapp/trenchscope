// trenchscope T1 — transaction DECODER + signer-side policy (SPEC §6.2 CL-04; task-1310 round 2, HIGH #1).
//
// The executor used to bind the confirm to a hash of the tx bytes but never looked INSIDE them. A
// hostile or changed Jupiter response could therefore hand us a transaction that moves something other
// than the plan (a drain, an Approve, a SetAuthority) and, as long as the bytes were stable across the
// wallet round trip, it was submitted. This module parses the Solana wire format (legacy + v0) with
// no external library and applies the §6.2 policy as a POSITIVE description of what a Jupiter swap IS
// (round 3 — an independent verifier showed the round-2 blacklist never required the transaction to be a
// swap, so a top-level SPL `Transfer`/`Burn` of the user's tokens to an attacker was signed and submitted
// while the SOL-only simulated delta saw just the fee leave the wallet):
//
//   * every top-level instruction's program must be on a small ALLOW-LIST (System, Token, Token-2022,
//     Associated Token, Compute Budget, Memo, Jupiter v6); any unknown program → refuse. DEX programs are
//     reached only by CPI from the route, so a DEX called directly at the top level → refuse. A program
//     id loaded from an address-lookup table → refuse (Solana itself forbids it, and we could not name it
//     without fetching the table).
//   * exactly ONE Jupiter instruction, and it must be a route-family instruction (by Anchor
//     discriminator). None → not a swap. Two → a second leg the plan never showed → refuse.
//   * Token / Token-2022 at the top level: ONLY `SyncNative`, `InitializeAccount*` for the user, and
//     `CloseAccount` with both the destination and the authority the user (Jupiter unwraps WSOL this
//     way). `Transfer`, `TransferChecked`, `Burn`, `BurnChecked`, `Approve`, `ApproveChecked`,
//     `SetAuthority`, `Revoke`, `MintTo`, `Freeze`/`Thaw` — anything else → refuse.
//   * System: ONLY `Transfer` from the user into the user's OWN wrapped-SOL account, i.e. an account that
//     is both `SyncNative`d and closed back to the user in the same transaction (the wrap step of
//     wrapAndUnwrapSol). Any other destination, source, or System instruction → refuse.
//   * Associated Token: ONLY `Create` / `CreateIdempotent` with the user as the owner.
//   * the fee payer (static key 0) must be the user, and the user must be a required signer.
//
// Pure functions, no I/O, no keys. Everything fails CLOSED: a transaction we cannot fully parse, or whose
// shape we did not anticipate, is a transaction we refuse to sign.

import { createPublicKey, verify as edVerify } from 'node:crypto';
import { base58, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../sources/solana-rpc.ts';
export { TOKEN_PROGRAM, TOKEN_2022_PROGRAM };

/**
 * Verify an Ed25519 signature over `message` by the raw 32-byte public key (node:crypto only; no key is
 * generated or stored). Shared by the wallet bridge (link proof) and the executor (signed-tx check).
 */
export function verifyEd25519(pubkey: Buffer, message: Buffer, signature: Buffer): boolean {
  if (pubkey.length !== 32 || signature.length !== 64) return false;
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pubkey]);
  const keyObj = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  return edVerify(null, message, keyObj, signature);
}

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const JUPITER_V6_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

/**
 * DEX programs Jupiter v6 routes through — documentation of the CPI targets a route may name as
 * ACCOUNTS of the route instruction. They are NOT top-level allow-listed (round 3): Jupiter reaches a
 * DEX only by CPI from the route, so a DEX called directly at the top level is not the swap shape and
 * is refused. Extend deliberately, never automatically.
 */
export const KNOWN_DEX_PROGRAMS: Readonly<Record<string, string>> = Object.freeze({
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM v4',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium CLMM',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 'Raydium CPMM',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpool',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'Meteora DLMM',
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB': 'Meteora Pools',
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG': 'Meteora DAMM v2',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'Pump.fun',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': 'PumpSwap',
  '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c': 'Lifinity v2',
  'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY': 'Phoenix',
  'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb': 'OpenBook v2',
  'SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe': 'SolFi',
  'obriQD1zbpyLz95G5n7nJe6a4DPjpFwa5XYPoNm113y': 'Obric v2',
  'ZERor4xhbUycZ6gb9ntrhqscUcZmAbQVRpxkonpqJXk': 'ZeroFi',
  'HyaB3W9q6XdA5xwpU4XnSZV94htfmbmqJXZcEbRaJutt': 'Invariant',
});

/**
 * The complete top-level program allow-list (SPEC §6.2). Frozen; unknown → refuse. Every program here
 * also has a whitelisted instruction SHAPE in checkTxPolicy; being allow-listed alone admits nothing.
 */
export const ALLOWED_PROGRAMS: ReadonlySet<string> = new Set<string>([
  SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM,
  MEMO_PROGRAM, JUPITER_V6_PROGRAM,
]);

export interface DecodedInstruction {
  programIdIndex: number;
  /** Base58 program id when it resolves to a static key; null when it points into a lookup table. */
  programId: string | null;
  /** Account indexes into the combined (static + lookup) key list. */
  accounts: number[];
  data: Buffer;
}

export interface DecodedTransaction {
  version: 'legacy' | 0;
  signatures: Buffer[];
  /** The exact message bytes (what the signatures are over). */
  message: Buffer;
  numRequiredSignatures: number;
  numReadonlySigned: number;
  numReadonlyUnsigned: number;
  /** Static account keys, base58. */
  staticKeys: string[];
  recentBlockhash: Buffer;
  instructions: DecodedInstruction[];
  /** Address-lookup tables (v0 only): table key + how many writable/readonly addresses it loads. */
  lookups: { table: string; writable: number[]; readonly: number[] }[];
}

export class TxDecodeError extends Error {
  constructor(message: string) { super(`malformed transaction: ${message}`); this.name = 'TxDecodeError'; }
}

class Reader {
  private off = 0;
  private readonly buf: Buffer;
  constructor(buf: Buffer) { this.buf = buf; }
  get offset(): number { return this.off; }
  get remaining(): number { return this.buf.length - this.off; }
  u8(): number {
    if (this.off >= this.buf.length) throw new TxDecodeError('unexpected end (u8)');
    return this.buf[this.off++];
  }
  bytes(n: number, what: string): Buffer {
    if (n < 0 || this.off + n > this.buf.length) throw new TxDecodeError(`unexpected end (${what})`);
    const out = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }
  /** Solana compact-u16 (shortvec). At most 3 bytes; values ≥ 2^16 are malformed. */
  shortvec(what: string): number {
    let value = 0;
    for (let i = 0; i < 3; i++) {
      const b = this.u8();
      value |= (b & 0x7f) << (7 * i);
      if ((b & 0x80) === 0) {
        if (i === 2 && (b & 0x7c) !== 0) throw new TxDecodeError(`shortvec overflow (${what})`);
        return value;
      }
    }
    throw new TxDecodeError(`shortvec too long (${what})`);
  }
}

/**
 * Decode a serialized transaction (legacy or v0). Throws TxDecodeError on ANY irregularity, including
 * trailing bytes — a transaction we cannot account for byte-by-byte is refused.
 */
export function decodeTransaction(buf: Buffer): DecodedTransaction {
  const r = new Reader(buf);
  const sigCount = r.shortvec('signature count');
  if (sigCount > 16) throw new TxDecodeError(`${sigCount} signatures`);
  const signatures: Buffer[] = [];
  for (let i = 0; i < sigCount; i++) signatures.push(Buffer.from(r.bytes(64, `signature ${i}`)));
  const message = Buffer.from(buf.subarray(r.offset));
  const m = new Reader(message);

  let version: 'legacy' | 0 = 'legacy';
  const first = m.u8();
  if (first & 0x80) {
    const v = first & 0x7f;
    if (v !== 0) throw new TxDecodeError(`unsupported message version ${v}`);
    version = 0;
  } else {
    // Legacy: the first byte IS numRequiredSignatures; rewind by re-reading below.
    version = 'legacy';
  }
  const numRequiredSignatures = version === 0 ? m.u8() : first;
  const numReadonlySigned = m.u8();
  const numReadonlyUnsigned = m.u8();
  if (numRequiredSignatures === 0) throw new TxDecodeError('no required signers');

  const keyCount = m.shortvec('account key count');
  if (keyCount === 0 || keyCount > 256) throw new TxDecodeError(`${keyCount} account keys`);
  if (numRequiredSignatures > keyCount) throw new TxDecodeError('more signers than keys');
  const staticKeys: string[] = [];
  for (let i = 0; i < keyCount; i++) staticKeys.push(base58(m.bytes(32, `account key ${i}`)));
  const recentBlockhash = Buffer.from(m.bytes(32, 'recent blockhash'));

  const ixCount = m.shortvec('instruction count');
  if (ixCount > 64) throw new TxDecodeError(`${ixCount} instructions`);
  const instructions: DecodedInstruction[] = [];
  for (let i = 0; i < ixCount; i++) {
    const programIdIndex = m.u8();
    const nAcc = m.shortvec(`instruction ${i} account count`);
    const accounts: number[] = [];
    for (let j = 0; j < nAcc; j++) accounts.push(m.u8());
    const dataLen = m.shortvec(`instruction ${i} data length`);
    const data = Buffer.from(m.bytes(dataLen, `instruction ${i} data`));
    instructions.push({ programIdIndex, programId: programIdIndex < keyCount ? staticKeys[programIdIndex] : null, accounts, data });
  }

  const lookups: DecodedTransaction['lookups'] = [];
  if (version === 0) {
    const nTables = m.shortvec('lookup table count');
    if (nTables > 32) throw new TxDecodeError(`${nTables} lookup tables`);
    for (let t = 0; t < nTables; t++) {
      const table = base58(m.bytes(32, `lookup table ${t}`));
      const nw = m.shortvec(`lookup ${t} writable count`);
      const writable: number[] = [];
      for (let j = 0; j < nw; j++) writable.push(m.u8());
      const nr = m.shortvec(`lookup ${t} readonly count`);
      const readonly: number[] = [];
      for (let j = 0; j < nr; j++) readonly.push(m.u8());
      lookups.push({ table, writable, readonly });
    }
  }
  if (m.remaining !== 0) throw new TxDecodeError(`${m.remaining} trailing bytes`);

  if (signatures.length !== numRequiredSignatures && signatures.length !== 0) {
    // A signed tx carries exactly numRequiredSignatures slots; an unsigned one from /swap also carries
    // the slots (zero-filled). Anything else is not a transaction we built.
    throw new TxDecodeError(`${signatures.length} signatures for ${numRequiredSignatures} required signers`);
  }

  return { version, signatures, message, numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned, staticKeys, recentBlockhash, instructions, lookups };
}

export type TxPolicyReason = 'program-not-allowed' | 'forbidden-instruction' | 'signer-mismatch' | 'not-a-swap';

export type TxPolicyResult = { ok: true } | { ok: false; reason: TxPolicyReason; message: string };

/**
 * Jupiter v6 route-family instructions — the ONLY Jupiter instructions a trenchscope swap may carry, keyed by
 * Anchor discriminator (sha256("global:<name>")[0..8]; recomputed, and `route` matches the transaction
 * shape used throughout the T1 suite). Any other Jupiter instruction at the top level (claim,
 * set_token_ledger, create_token_account, …) is not a swap and is refused.
 */
export const JUPITER_ROUTE_DISCRIMINATORS: ReadonlyMap<string, string> = new Map<string, string>([
  ['e517cb977ae3ad2a', 'route'],
  ['c1209b3341d69c81', 'shared_accounts_route'],
  ['96564774a75d0e68', 'route_with_token_ledger'],
  ['e6798f50779f6aaa', 'shared_accounts_route_with_token_ledger'],
  ['d033ef977b2bed5c', 'exact_out_route'],
  ['b0d169a89a7d453e', 'shared_accounts_exact_out_route'],
]);

// SPL Token / Token-2022 instruction discriminators (first data byte). Token-2022 shares the legacy
// numbering. Only the WHITELISTED set (SyncNative, InitializeAccount* for the user, CloseAccount to the
// user) may appear at the top level of a swap; every other op is refused, and is named so the refusal
// can say what the transaction tried to do.
const TOKEN_INITIALIZE_ACCOUNT = 1, TOKEN_TRANSFER = 3, TOKEN_APPROVE = 4, TOKEN_SET_AUTHORITY = 6, TOKEN_BURN = 8,
  TOKEN_CLOSE_ACCOUNT = 9, TOKEN_TRANSFER_CHECKED = 12, TOKEN_APPROVE_CHECKED = 13, TOKEN_BURN_CHECKED = 15,
  TOKEN_INITIALIZE_ACCOUNT2 = 16, TOKEN_SYNC_NATIVE = 17, TOKEN_INITIALIZE_ACCOUNT3 = 18;
const TOKEN_OP_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: 'InitializeMint', 1: 'InitializeAccount', 2: 'InitializeMultisig', 3: 'Transfer', 4: 'Approve', 5: 'Revoke',
  6: 'SetAuthority', 7: 'MintTo', 8: 'Burn', 9: 'CloseAccount', 10: 'FreezeAccount', 11: 'ThawAccount',
  12: 'TransferChecked', 13: 'ApproveChecked', 14: 'MintToChecked', 15: 'BurnChecked', 16: 'InitializeAccount2',
  17: 'SyncNative', 18: 'InitializeAccount3',
});
// System program instruction indexes (u32 LE). Only Transfer — into the user's own wrapped-SOL account —
// is part of a swap; everything else (CreateAccount*, Assign*, Allocate*, nonce ops, TransferWithSeed) is
// refused.
const SYSTEM_TRANSFER = 2;
const SYSTEM_OP_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: 'CreateAccount', 1: 'Assign', 2: 'Transfer', 3: 'CreateAccountWithSeed', 4: 'AdvanceNonceAccount',
  5: 'WithdrawNonceAccount', 6: 'InitializeNonceAccount', 7: 'AuthorizeNonceAccount', 8: 'Allocate',
  9: 'AllocateWithSeed', 10: 'AssignWithSeed', 11: 'TransferWithSeed', 12: 'UpgradeNonceAccount',
});
// Associated Token program: Create (empty data or 0) and CreateIdempotent (1), for the user only.
const ATA_CREATE = 0, ATA_CREATE_IDEMPOTENT = 1;

/**
 * Apply the §6.2 policy to a decoded transaction for `userPublicKey`. Pure. The policy is a POSITIVE
 * description of what a Jupiter swap IS (round 3): the transaction is refused unless every top-level
 * instruction fits one of the whitelisted shapes AND exactly one of them is a Jupiter route. Refuses on
 * the first violation; the message names it so the ticket can show why.
 */
export function checkTxPolicy(tx: DecodedTransaction, userPublicKey: string, allowed: ReadonlySet<string> = ALLOWED_PROGRAMS): TxPolicyResult {
  if (tx.staticKeys[0] !== userPublicKey) {
    return { ok: false, reason: 'signer-mismatch', message: `fee payer ${short(tx.staticKeys[0])} is not the linked wallet` };
  }
  const userIndex = tx.staticKeys.indexOf(userPublicKey);
  if (userIndex < 0 || userIndex >= tx.numRequiredSignatures) {
    return { ok: false, reason: 'signer-mismatch', message: 'the linked wallet is not a required signer' };
  }
  const keyAt = (i: number): string | null => (i < tx.staticKeys.length ? tx.staticKeys[i] : null);
  const refuse = (reason: TxPolicyReason, message: string): TxPolicyResult => ({ ok: false, reason, message });

  // Pass 1: which accounts count as the user's OWN wrapped-SOL account in this transaction — one that is
  // BOTH SyncNative'd (so it is a wrapped-SOL token account) AND closed back to the user by the user (so
  // the user is its owner; CloseAccount's authority check is enforced on-chain, so a lie here fails the
  // simulation). A System Transfer may fund nothing else.
  const synced = new Set<string>();
  const closedToUser = new Set<string>();
  for (const ix of tx.instructions) {
    if (ix.programId !== TOKEN_PROGRAM && ix.programId !== TOKEN_2022_PROGRAM) continue;
    const op = ix.data.length > 0 ? ix.data[0] : -1;
    const acct = ix.accounts.length > 0 ? keyAt(ix.accounts[0]) : null;
    if (acct === null) continue;
    if (op === TOKEN_SYNC_NATIVE) synced.add(acct);
    if (op === TOKEN_CLOSE_ACCOUNT && ix.accounts.length > 2 && keyAt(ix.accounts[1]) === userPublicKey && keyAt(ix.accounts[2]) === userPublicKey) {
      closedToUser.add(acct);
    }
  }
  const isUserWsol = (k: string | null): boolean => k !== null && synced.has(k) && closedToUser.has(k);

  // Pass 2: every top-level instruction must fit a whitelisted shape. (Shape violations are reported
  // before the route count below so a transaction that is both not-a-swap AND carries a forbidden
  // instruction names the instruction.)
  let routes = 0;
  for (let i = 0; i < tx.instructions.length; i++) {
    const ix = tx.instructions[i];
    if (ix.programId === null) return refuse('program-not-allowed', `instruction ${i}: program loaded from a lookup table`);
    if (!allowed.has(ix.programId)) return refuse('program-not-allowed', `instruction ${i}: program ${short(ix.programId)} is not allow-listed`);
    const pid = ix.programId;

    // Compute-budget and memo instructions cannot move funds.
    if (pid === COMPUTE_BUDGET_PROGRAM || pid === MEMO_PROGRAM) continue;

    if (pid === JUPITER_V6_PROGRAM) {
      const disc = ix.data.length >= 8 ? ix.data.subarray(0, 8).toString('hex') : '';
      if (!JUPITER_ROUTE_DISCRIMINATORS.has(disc)) return refuse('not-a-swap', `instruction ${i}: Jupiter instruction ${disc || '(empty)'} is not a route`);
      routes++;
      continue;
    }

    if (pid === TOKEN_PROGRAM || pid === TOKEN_2022_PROGRAM) {
      const op = ix.data.length > 0 ? ix.data[0] : -1;
      const name = TOKEN_OP_NAMES[op] ?? `op ${op}`;
      if (op === TOKEN_SYNC_NATIVE) continue;
      if (op === TOKEN_CLOSE_ACCOUNT) {
        // accounts: [account to close, destination (receives the lamports), owner/authority]
        const dest = ix.accounts.length > 1 ? keyAt(ix.accounts[1]) : null;
        const owner = ix.accounts.length > 2 ? keyAt(ix.accounts[2]) : null;
        if (dest !== userPublicKey || owner !== userPublicKey) return refuse('forbidden-instruction', `instruction ${i}: CloseAccount to a foreign owner/destination`);
        continue;
      }
      if (op === TOKEN_INITIALIZE_ACCOUNT) {
        // accounts: [account, mint, owner, rent sysvar]
        const owner = ix.accounts.length > 2 ? keyAt(ix.accounts[2]) : null;
        if (owner !== userPublicKey) return refuse('forbidden-instruction', `instruction ${i}: InitializeAccount for a foreign owner`);
        continue;
      }
      if (op === TOKEN_INITIALIZE_ACCOUNT2 || op === TOKEN_INITIALIZE_ACCOUNT3) {
        // data: [op, owner (32 bytes)]
        const owner = ix.data.length >= 33 ? base58(ix.data.subarray(1, 33)) : null;
        if (owner !== userPublicKey) return refuse('forbidden-instruction', `instruction ${i}: ${name} for a foreign owner`);
        continue;
      }
      // Everything else is never part of a swap trenchscope signs. The user's tokens move ONLY inside the
      // route; a top-level Transfer/Burn is a drain whatever the rest of the transaction looks like.
      if (op === TOKEN_APPROVE || op === TOKEN_APPROVE_CHECKED) return refuse('forbidden-instruction', `instruction ${i}: token Approve (delegation) is never signed`);
      if (op === TOKEN_SET_AUTHORITY) return refuse('forbidden-instruction', `instruction ${i}: token SetAuthority is never signed`);
      if (op === TOKEN_TRANSFER || op === TOKEN_TRANSFER_CHECKED) return refuse('forbidden-instruction', `instruction ${i}: a direct token ${name} is never signed (a swap moves tokens only inside the route)`);
      if (op === TOKEN_BURN || op === TOKEN_BURN_CHECKED) return refuse('forbidden-instruction', `instruction ${i}: token ${name} is never signed`);
      return refuse('forbidden-instruction', `instruction ${i}: token ${name} is not part of a swap`);
    }

    if (pid === SYSTEM_PROGRAM) {
      const op = ix.data.length >= 4 ? ix.data.readUInt32LE(0) : -1;
      const name = SYSTEM_OP_NAMES[op] ?? `op ${op}`;
      if (op !== SYSTEM_TRANSFER) return refuse('forbidden-instruction', `instruction ${i}: System ${name} is not part of a swap`);
      // accounts: [from, to]. Only the user wrapping SOL into their OWN wrapped-SOL account.
      const from = ix.accounts.length > 0 ? keyAt(ix.accounts[0]) : null;
      const to = ix.accounts.length > 1 ? keyAt(ix.accounts[1]) : null;
      if (from !== userPublicKey) return refuse('forbidden-instruction', `instruction ${i}: System Transfer from an account that is not the wallet`);
      if (!isUserWsol(to)) {
        return refuse('forbidden-instruction', `instruction ${i}: System Transfer to ${short(to ?? undefined)} — only the wallet's own wrapped-SOL account (synced and closed back to the wallet in this transaction) may be funded`);
      }
      continue;
    }

    if (pid === ASSOCIATED_TOKEN_PROGRAM) {
      // accounts: [funder, ata, owner (wallet), mint, system, token]; data: empty / 0 = Create, 1 = CreateIdempotent
      const op = ix.data.length === 0 ? ATA_CREATE : ix.data[0];
      if (op !== ATA_CREATE && op !== ATA_CREATE_IDEMPOTENT) return refuse('forbidden-instruction', `instruction ${i}: Associated Token op ${op} is not part of a swap`);
      const owner = ix.accounts.length > 2 ? keyAt(ix.accounts[2]) : null;
      if (owner !== userPublicKey) return refuse('forbidden-instruction', `instruction ${i}: creating a token account for a foreign owner`);
      continue;
    }

    // Allow-listed by a caller-supplied set but with no whitelisted shape here: extending the allow-list
    // without teaching the shape rule fails closed.
    return refuse('not-a-swap', `instruction ${i}: program ${short(pid)} has no swap shape`);
  }

  // Pass 3: a swap is exactly ONE Jupiter route. None → whatever this is, it is not a swap. Two or more →
  // a second route could move a second leg the plan never showed.
  if (routes === 0) return refuse('not-a-swap', 'the transaction carries no Jupiter route instruction');
  if (routes > 1) return refuse('not-a-swap', `the transaction carries ${routes} Jupiter route instructions; a plan is one swap`);
  return { ok: true };
}

function short(s: string | undefined): string {
  return s === undefined ? '?' : s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

// =====================================================================================================
// task-1328 (T2): BIND the one Jupiter route to the PLAN, tolerate Phantom's Lighthouse tail, and the
// devnet PROBE shape. Everything below is pure and fails closed.
//
// Recorded 2026-10-09 from the real keyless `/swap/v1/swap` (fixtures/trade/jupiter-swap-*.json): a
// SOL→USDC buy is `shared_accounts_route`, a USDC→SOL sell is `route`; both pass checkTxPolicy as
// written in round 3, and the route instruction's trailing args are exactly the quote's `inAmount`,
// `outAmount`, `slippageBps` and a zero platform fee. So the route instruction ITSELF can be bound to
// the plan: the signer refuses a route whose amounts/accounts are not the plan's.

import { base58Decode, findProgramAddress } from '../sources/pda.ts';

/** Lighthouse assertion program (Phantom appends assertion instructions; same id on devnet + mainnet). */
export const LIGHTHOUSE_PROGRAM = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Lighthouse instruction discriminators (u8, lighthouse `instruction.rs`). All of them either ASSERT
 * runtime state (and fail the tx when the assertion fails) or write/close a small memory PDA funded by
 * the payer — none can move the user's tokens. Unknown discriminators are refused.
 */
export const LIGHTHOUSE_OPS: Readonly<Record<number, string>> = Object.freeze({
  0: 'MemoryWrite', 1: 'MemoryClose', 2: 'AssertAccountData', 3: 'AssertAccountDelta', 4: 'AssertAccountInfo',
  5: 'AssertAccountInfoMulti', 6: 'AssertMintAccount', 7: 'AssertMintAccountMulti', 8: 'AssertTokenAccount',
  9: 'AssertTokenAccountMulti', 10: 'AssertStakeAccount', 11: 'AssertStakeAccountMulti',
  12: 'AssertUpgradeableLoaderAccount', 13: 'AssertUpgradeableLoaderAccountMulti', 14: 'AssertSysvarClock',
  15: 'AssertMerkleTreeAccount', 16: 'AssertBubblegumTreeConfigAccount',
});

/** The associated token address of `owner` for `mint` under a token program. Pure (sha256 + curve check). */
export function associatedTokenAddress(owner: string, mint: string, tokenProgram: string = TOKEN_PROGRAM): string {
  return findProgramAddress([base58Decode(owner), base58Decode(tokenProgram), base58Decode(mint)], base58Decode(ASSOCIATED_TOKEN_PROGRAM)).address;
}

/**
 * Account layout of the ExactIn route family (Jupiter v6 IDL; confirmed against the recorded fixtures:
 * `route` sell = [token_program, user_transfer_authority, user_source, user_destination, …];
 * `shared_accounts_route` buy = [token_program, program_authority, user_transfer_authority, source,
 * program_source, program_destination, destination, source_mint, destination_mint, platform_fee, …]).
 * The ExactOut family is NOT accepted: trenchscope only ever quotes ExactIn, so an exact-out route is a
 * transaction we did not plan.
 */
interface RouteLayout { authority: number; source: number; destination: number; platformFee: number }
const ROUTE_LAYOUT: Readonly<Record<string, RouteLayout>> = Object.freeze({
  route: { authority: 1, source: 2, destination: 3, platformFee: 6 },
  route_with_token_ledger: { authority: 1, source: 2, destination: 3, platformFee: 6 },
  shared_accounts_route: { authority: 2, source: 3, destination: 6, platformFee: 9 },
  shared_accounts_route_with_token_ledger: { authority: 2, source: 3, destination: 6, platformFee: 9 },
});

export interface RouteArgs { inAmount: bigint; quotedOutAmount: bigint; slippageBps: number; platformFeeBps: number }

/** The ExactIn route args sit at the END of the data: in_amount u64, quoted_out_amount u64, slippage_bps u16, platform_fee_bps u8. */
export function parseRouteArgs(data: Buffer): RouteArgs | null {
  if (data.length < 8 + 19) return null;
  const n = data.length;
  return { inAmount: data.readBigUInt64LE(n - 19), quotedOutAmount: data.readBigUInt64LE(n - 11), slippageBps: data.readUInt16LE(n - 3), platformFeeBps: data[n - 1] };
}

/** What the plan says the swap is; the route instruction must agree on every field. */
export interface SwapExpectation {
  user: string;
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  slippageBps: number;
}

export type SwapBindingReason = 'not-a-swap' | 'quote-mismatch' | 'forbidden-instruction';
export type SwapBindingResult = { ok: true; route: string; args: RouteArgs } | { ok: false; reason: SwapBindingReason; message: string };

/**
 * Bind the transaction's one Jupiter route to the plan (task-1328, closes the T1 residual "the route
 * instruction itself is unchecked" / "sell leg and buy destination unverified"):
 *   * the route is an ExactIn family instruction with parseable args;
 *   * `in_amount`, `quoted_out_amount` and `slippage_bps` equal the plan's quote (a route sized to the
 *     user's whole balance, or re-priced, is refused);
 *   * `platform_fee_bps` is 0 and no platform-fee account is set (trenchscope takes no fee, SPEC §6.9);
 *   * `user_transfer_authority` is the wallet; the SOURCE token account is the wallet's own associated
 *     token account for the INPUT mint (the sell leg can only spend the planned mint from the wallet's
 *     own account) and the DESTINATION is the wallet's own ATA for the OUTPUT mint (a buy can only land
 *     in the wallet); Token-2022 ATAs are accepted for the non-SOL mint;
 *   * every Associated-Token `Create` and every System `Transfer` destination is one of those same
 *     accounts (nothing is created or funded for any other mint or owner).
 * A user account that lives in an address-lookup table cannot be named statically → refused (closed).
 */
export function checkSwapBinding(tx: DecodedTransaction, expect: SwapExpectation): SwapBindingResult {
  const refuse = (reason: SwapBindingReason, message: string): SwapBindingResult => ({ ok: false, reason, message });
  const keyAt = (i: number): string | null => (i < tx.staticKeys.length ? tx.staticKeys[i] : null);
  const user = expect.user;
  const atas = (mint: string): string[] => (mint === WSOL_MINT
    ? [associatedTokenAddress(user, mint, TOKEN_PROGRAM)]
    : [associatedTokenAddress(user, mint, TOKEN_PROGRAM), associatedTokenAddress(user, mint, TOKEN_2022_PROGRAM)]);
  let sourceAtas: string[], destAtas: string[];
  try { sourceAtas = atas(expect.inputMint); destAtas = atas(expect.outputMint); } catch (e) {
    return refuse('quote-mismatch', `cannot derive the wallet's token accounts: ${e instanceof Error ? e.message : String(e)}`);
  }
  const own = new Set([...sourceAtas, ...destAtas, ...atas(WSOL_MINT)]);

  const routes = tx.instructions.map((ix, i) => ({ ix, i })).filter(({ ix }) => ix.programId === JUPITER_V6_PROGRAM);
  if (routes.length !== 1) return refuse('not-a-swap', `the transaction carries ${routes.length} Jupiter instructions; a plan is one swap`);
  const { ix, i } = routes[0];
  const disc = ix.data.length >= 8 ? ix.data.subarray(0, 8).toString('hex') : '';
  const name = JUPITER_ROUTE_DISCRIMINATORS.get(disc) ?? '';
  const layout = ROUTE_LAYOUT[name];
  if (!layout) return refuse('not-a-swap', `instruction ${i}: Jupiter ${name || disc || '(empty)'} is not an ExactIn route`);
  const args = parseRouteArgs(ix.data);
  if (!args) return refuse('not-a-swap', `instruction ${i}: route args too short`);
  if (args.inAmount !== expect.inAmount) return refuse('quote-mismatch', `route in_amount ${args.inAmount} is not the plan's ${expect.inAmount}`);
  if (args.quotedOutAmount !== expect.outAmount) return refuse('quote-mismatch', `route quoted_out_amount ${args.quotedOutAmount} is not the plan's ${expect.outAmount}`);
  if (args.slippageBps !== expect.slippageBps) return refuse('quote-mismatch', `route slippage ${args.slippageBps} bps is not the plan's ${expect.slippageBps} bps`);
  if (args.platformFeeBps !== 0) return refuse('forbidden-instruction', `route carries a ${args.platformFeeBps} bps platform fee; trenchscope takes no fee`);
  const need = Math.max(layout.authority, layout.source, layout.destination, layout.platformFee) + 1;
  if (ix.accounts.length < need) return refuse('not-a-swap', `instruction ${i}: route has ${ix.accounts.length} accounts; ${name} needs ≥ ${need}`);
  const authority = keyAt(ix.accounts[layout.authority]);
  const source = keyAt(ix.accounts[layout.source]);
  const destination = keyAt(ix.accounts[layout.destination]);
  const platformFee = keyAt(ix.accounts[layout.platformFee]);
  if (authority !== user) return refuse('forbidden-instruction', `route transfer authority ${short(authority ?? undefined)} is not the wallet`);
  if (source === null || !sourceAtas.includes(source)) return refuse('forbidden-instruction', `route source ${short(source ?? undefined)} is not the wallet's ${short(expect.inputMint)} token account`);
  if (destination === null || !destAtas.includes(destination)) return refuse('forbidden-instruction', `route destination ${short(destination ?? undefined)} is not the wallet's ${short(expect.outputMint)} token account`);
  // "No platform fee account" is encoded as the program id itself in the optional slot.
  if (platformFee !== JUPITER_V6_PROGRAM) return refuse('forbidden-instruction', `route names a platform-fee account ${short(platformFee ?? undefined)}; trenchscope takes no fee`);

  for (let j = 0; j < tx.instructions.length; j++) {
    const x = tx.instructions[j];
    if (x.programId === ASSOCIATED_TOKEN_PROGRAM) {
      const ata = x.accounts.length > 1 ? keyAt(x.accounts[1]) : null;
      if (ata === null || !own.has(ata)) return refuse('forbidden-instruction', `instruction ${j}: creates a token account ${short(ata ?? undefined)} that is not one of the wallet's accounts for this swap`);
    }
    if (x.programId === SYSTEM_PROGRAM) {
      const to = x.accounts.length > 1 ? keyAt(x.accounts[1]) : null;
      const wsol = atas(WSOL_MINT)[0];
      if (to !== wsol) return refuse('forbidden-instruction', `instruction ${j}: System Transfer to ${short(to ?? undefined)} is not the wallet's wrapped-SOL account`);
    }
  }
  return { ok: true, route: name, args };
}

// ----------------------------------------------------------------------------------------------- Lighthouse

/** A compiled account reference that survives static-key re-indexing: a key, or a lookup-table slot. */
type AccountRef = { key: string } | { table: string; kind: 'w' | 'r'; index: number } | { bad: number };

function resolveRef(tx: DecodedTransaction, idx: number): AccountRef {
  if (idx < tx.staticKeys.length) return { key: tx.staticKeys[idx] };
  let off = idx - tx.staticKeys.length;
  for (const l of tx.lookups) { if (off < l.writable.length) return { table: l.table, kind: 'w', index: l.writable[off] }; off -= l.writable.length; }
  for (const l of tx.lookups) { if (off < l.readonly.length) return { table: l.table, kind: 'r', index: l.readonly[off] }; off -= l.readonly.length; }
  return { bad: idx };
}

function sameRef(a: AccountRef, b: AccountRef): boolean {
  if ('key' in a || 'key' in b) return 'key' in a && 'key' in b && a.key === b.key;
  if ('bad' in a || 'bad' in b) return false;
  return a.table === b.table && a.kind === b.kind && a.index === b.index;
}

function sameInstruction(a: DecodedTransaction, ia: DecodedInstruction, b: DecodedTransaction, ib: DecodedInstruction): boolean {
  if (ia.programId === null || ib.programId === null || ia.programId !== ib.programId) return false;
  if (!ia.data.equals(ib.data)) return false;
  if (ia.accounts.length !== ib.accounts.length) return false;
  for (let k = 0; k < ia.accounts.length; k++) if (!sameRef(resolveRef(a, ia.accounts[k]), resolveRef(b, ib.accounts[k]))) return false;
  return true;
}

export type ApprovedMessageResult = { ok: true; lighthouseTail: number } | { ok: false; message: string };

/**
 * Is `signed` the message the user approved? Exact bytes → yes. Otherwise the ONLY tolerated difference
 * (task-1328, "handle Phantom Lighthouse instructions") is that Phantom APPENDED Lighthouse assertion
 * instructions: same version, same blockhash, same signer count, same fee payer, same lookup tables, and
 * every approved instruction present in order with the same program, data and (re-indexed) accounts;
 * the tail must be Lighthouse instructions with known discriminators. Any other change — a dropped,
 * reordered or edited instruction, a new non-Lighthouse instruction, a changed blockhash — is a
 * mismatch. The caller still re-runs policy and re-simulates the signed bytes.
 */
export function compareApprovedMessage(approved: DecodedTransaction, signed: DecodedTransaction): ApprovedMessageResult {
  if (approved.message.equals(signed.message)) return { ok: true, lighthouseTail: 0 };
  const no = (message: string): ApprovedMessageResult => ({ ok: false, message });
  if (approved.version !== signed.version) return no('message version changed');
  if (!approved.recentBlockhash.equals(signed.recentBlockhash)) return no('recent blockhash changed');
  if (approved.numRequiredSignatures !== signed.numRequiredSignatures) return no('signer count changed');
  if (approved.staticKeys[0] !== signed.staticKeys[0]) return no('fee payer changed');
  if (approved.lookups.length !== signed.lookups.length) return no('lookup tables changed');
  for (let t = 0; t < approved.lookups.length; t++) {
    const a = approved.lookups[t], b = signed.lookups[t];
    if (a.table !== b.table || a.writable.join(',') !== b.writable.join(',') || a.readonly.join(',') !== b.readonly.join(',')) return no('lookup tables changed');
  }
  if (signed.instructions.length < approved.instructions.length) return no('an approved instruction was dropped');
  for (let i = 0; i < approved.instructions.length; i++) {
    if (!sameInstruction(approved, approved.instructions[i], signed, signed.instructions[i])) return no(`instruction ${i} differs from the approved plan`);
  }
  const tail = signed.instructions.slice(approved.instructions.length);
  for (let k = 0; k < tail.length; k++) {
    const ix = tail[k];
    if (ix.programId !== LIGHTHOUSE_PROGRAM) return no(`appended instruction ${approved.instructions.length + k} is not a Lighthouse assertion (${short(ix.programId ?? undefined)})`);
    const op = ix.data.length > 0 ? ix.data[0] : -1;
    if (!(op in LIGHTHOUSE_OPS)) return no(`appended Lighthouse instruction has unknown discriminator ${op}`);
  }
  // Every static key the approved message named must still be present (Phantom may add keys, never remove).
  for (const k of approved.staticKeys) if (!signed.staticKeys.includes(k)) return no(`account ${short(k)} vanished from the message`);
  return { ok: true, lighthouseTail: tail.length };
}

// ----------------------------------------------------------------------------------------------- shapes

export interface TxPolicyOptions {
  /**
   * 'swap' (default): exactly one Jupiter route (round 3). 'probe': the devnet plumbing transaction —
   * the wrap-and-unwrap shape with NO route (ATA create for the wallet, System Transfer into the
   * wallet's own wrapped-SOL account, SyncNative, CloseAccount back to the wallet, memo, compute
   * budget). A probe moves nothing but fees and is only ever planned on devnet.
   */
  kind?: 'swap' | 'probe';
  /**
   * Accept a Lighthouse assertion TAIL (Phantom's augmentation) — only for the SIGNED transaction the
   * executor already matched to the approved plan with compareApprovedMessage. Never for unsigned bytes.
   */
  lighthouseTail?: boolean;
}

/**
 * checkTxPolicy for the probe / Lighthouse cases: strips a trailing run of Lighthouse instructions (if
 * allowed and well-formed), runs the round-3 policy on the rest, and applies the route-count rule for
 * the kind. Kept as a separate entry point so the round-3 function and its tests stay byte-for-byte.
 */
export function checkTxPolicyWith(tx: DecodedTransaction, userPublicKey: string, allowed: ReadonlySet<string> = ALLOWED_PROGRAMS, opts: TxPolicyOptions = {}): TxPolicyResult {
  let ixs = tx.instructions;
  if (opts.lighthouseTail) {
    let cut = ixs.length;
    while (cut > 0 && ixs[cut - 1].programId === LIGHTHOUSE_PROGRAM) cut--;
    for (let k = cut; k < ixs.length; k++) {
      const op = ixs[k].data.length > 0 ? ixs[k].data[0] : -1;
      if (!(op in LIGHTHOUSE_OPS)) return { ok: false, reason: 'forbidden-instruction', message: `instruction ${k}: unknown Lighthouse op ${op}` };
    }
    ixs = ixs.slice(0, cut);
  }
  // A Lighthouse instruction anywhere but the tolerated tail is never part of a swap.
  for (let k = 0; k < ixs.length; k++) if (ixs[k].programId === LIGHTHOUSE_PROGRAM) return { ok: false, reason: 'program-not-allowed', message: `instruction ${k}: Lighthouse outside the appended tail` };
  const base: DecodedTransaction = { ...tx, instructions: ixs };
  if ((opts.kind ?? 'swap') === 'swap') return checkTxPolicy(base, userPublicKey, allowed);
  // probe: run the same per-instruction shape rules but require ZERO routes and at least the wrap shape.
  const withRoute = checkTxPolicy(base, userPublicKey, allowed);
  if (!withRoute.ok && withRoute.reason !== 'not-a-swap') return withRoute;
  const routes = ixs.filter((ix) => ix.programId === JUPITER_V6_PROGRAM).length;
  if (routes !== 0) return { ok: false, reason: 'not-a-swap', message: 'a probe carries no Jupiter route' };
  const wsol = associatedTokenAddress(userPublicKey, WSOL_MINT, TOKEN_PROGRAM);
  const keyAt = (i: number): string | null => (i < tx.staticKeys.length ? tx.staticKeys[i] : null);
  let synced = false, closed = false, funded = false;
  for (let k = 0; k < ixs.length; k++) {
    const ix = ixs[k];
    if (ix.programId === TOKEN_PROGRAM && ix.data[0] === 17 && keyAt(ix.accounts[0]) === wsol) synced = true;
    if (ix.programId === TOKEN_PROGRAM && ix.data[0] === 9 && keyAt(ix.accounts[0]) === wsol) closed = true;
    if (ix.programId === SYSTEM_PROGRAM) { if (keyAt(ix.accounts[1] ?? -1) !== wsol) return { ok: false, reason: 'forbidden-instruction', message: `instruction ${k}: probe transfer must fund the wallet's own wrapped-SOL account` }; funded = true; }
    if (ix.programId === ASSOCIATED_TOKEN_PROGRAM && keyAt(ix.accounts[1] ?? -1) !== wsol) return { ok: false, reason: 'forbidden-instruction', message: `instruction ${k}: probe may only create the wallet's wrapped-SOL account` };
  }
  if (!synced || !closed || !funded) return { ok: false, reason: 'not-a-swap', message: 'a probe is the wrap-and-unwrap shape (fund + SyncNative + CloseAccount to the wallet)' };
  return { ok: true };
}
