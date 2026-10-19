// trenchscope T2 — the DEVNET PROBE transaction builder (task-1328). Jupiter has no devnet, so the way to
// prove the real signing path end to end on devnet — keypress → Phantom sign → decode/verify →
// re-simulate → submit → confirm — without any value at risk is a transaction trenchscope builds itself:
// the wrap-and-unwrap shape a Jupiter swap uses around its route, with NO route:
//
//   AssociatedToken.CreateIdempotent(wallet's WSOL ATA)  ·  System.Transfer(wallet → WSOL ATA, 0.001 SOL)
//   Token.SyncNative(WSOL ATA)  ·  Memo("trenchscope devnet probe")  ·  Token.CloseAccount(WSOL ATA → wallet)
//
// The close returns the lamports (and the ATA rent) to the wallet in the same transaction, so the only
// SOL that leaves is the network fee. The signer's policy for the probe kind refuses any other shape, and
// the probe is refused outright unless the RPC endpoint classifies as devnet. No key, no network write:
// this module only builds bytes; the executor simulates and the wallet signs.

import { base58Decode } from '../../sources/pda.ts';
import type { TradeRpc } from '../rpc-exec.ts';
import { rpcNetwork } from '../rpc-exec.ts';
import { associatedTokenAddress, ASSOCIATED_TOKEN_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM, MEMO_PROGRAM, WSOL_MINT } from '../tx-decode.ts';
import type { ProbeBuilder } from '../executor.ts';

export const PROBE_LAMPORTS = 1_000_000n; // 0.001 SOL, wrapped then unwrapped in the same tx
export const PROBE_MEMO = 'trenchscope devnet probe';

function shortvec(n: number): Buffer {
  const out: number[] = [];
  do { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
}

interface Ix { program: string; accounts: string[]; data: Buffer }

/**
 * Compile a LEGACY message (no lookup tables needed) with the wallet as the single signer/fee payer.
 * Key order follows the runtime's rule: writable signers, then writable non-signers, then readonly
 * non-signers. Exported for the tests (they decode what this builds with the real decoder).
 */
export function compileProbeMessage(user: string, blockhash: string, lamports: bigint = PROBE_LAMPORTS, memo: string = PROBE_MEMO): Buffer {
  const wsolAta = associatedTokenAddress(user, WSOL_MINT, TOKEN_PROGRAM);
  const transfer = Buffer.alloc(12); transfer.writeUInt32LE(2, 0); transfer.writeBigUInt64LE(lamports, 4);
  const ixs: Ix[] = [
    { program: ASSOCIATED_TOKEN_PROGRAM, accounts: [user, wsolAta, user, WSOL_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM], data: Buffer.from([1]) },
    { program: SYSTEM_PROGRAM, accounts: [user, wsolAta], data: transfer },
    { program: TOKEN_PROGRAM, accounts: [wsolAta], data: Buffer.from([17]) },
    { program: MEMO_PROGRAM, accounts: [], data: Buffer.from(memo, 'utf8') },
    { program: TOKEN_PROGRAM, accounts: [wsolAta, user, user], data: Buffer.from([9]) },
  ];
  const writable = [user, wsolAta];
  const readonly = [WSOL_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, MEMO_PROGRAM];
  const keys = [...writable, ...readonly];
  const index = (k: string): number => { const i = keys.indexOf(k); if (i < 0) throw new Error(`probe: unknown key ${k}`); return i; };
  const parts: Buffer[] = [Buffer.from([1, 0, readonly.length]), shortvec(keys.length)];
  for (const k of keys) parts.push(Buffer.from(base58Decode(k)));
  parts.push(Buffer.from(base58Decode(blockhash)), shortvec(ixs.length));
  for (const ix of ixs) {
    const acc = ix.accounts.map(index);
    parts.push(Buffer.from([index(ix.program)]), shortvec(acc.length), Buffer.from(acc), shortvec(ix.data.length), ix.data);
  }
  return Buffer.concat(parts);
}

/** The unsigned wire transaction (one zero signature slot + the message), base64. */
export function probeWire(message: Buffer): string {
  return Buffer.concat([shortvec(1), Buffer.alloc(64), message]).toString('base64');
}

export class DevnetProbeBuilder implements ProbeBuilder {
  private readonly rpc: TradeRpc;
  constructor(rpc: TradeRpc) { this.rpc = rpc; }

  /**
   * The probe (0.001 SOL, the fixed memo) or — task-1363 — a DEVNET FILL for the fast wallet: the same
   * wrap-and-unwrap shape sized to a plan's SOL leg, with a memo naming the plan leg. Devnet only either way.
   */
  async build(userPublicKey: string, opts: { lamports?: bigint; memo?: string } = {}): Promise<{ txBase64: string; lamports: bigint }> {
    if (rpcNetwork(this.rpc.url, (this.rpc as Partial<TradeRpc>).network ?? null) !== 'devnet') throw new Error('the probe builds only against a devnet RPC endpoint');
    if (base58Decode(userPublicKey).length !== 32) throw new Error('probe: bad wallet public key');
    const lamports = opts.lamports ?? PROBE_LAMPORTS;
    if (!(lamports > 0n)) throw new Error('probe: lamports must be positive');
    const memo = (opts.memo ?? PROBE_MEMO).replace(/[^\x20-\x7e]/g, '?').slice(0, 96);
    const { blockhash } = await this.rpc.latestBlockhash();
    const message = compileProbeMessage(userPublicKey, blockhash, lamports, memo);
    return { txBase64: probeWire(message), lamports };
  }
}

