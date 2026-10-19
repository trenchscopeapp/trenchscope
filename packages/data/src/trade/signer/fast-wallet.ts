// task-1363 — the capped FAST WALLET (SPEC §6.13.2 `wallet: 'fast'`): the one key trenchscope ever holds, and only
// on DEVNET. Standing-mandate fills must run at machine speed, which a Phantom round-trip per fill cannot do,
// so an armed mandate fires from this separate hot key instead of the user's main wallet. The main wallet is
// never named by a mandate (the schema says `fast`), and this signer refuses to sign for any other public key.
//
// Boundaries, by construction:
//   * devnet only — the record carries `network: 'devnet'`; create/load refuse anything else, and the signer
//     process only loads it when ITS RPC endpoint classifies as devnet (signer/main.ts). There is no mainnet path.
//   * created only by `trenchscope wallet fast create` on a real TTY after a keypress; there is NO channel method
//     to create, export, import or replace it (the signer protocol has `fast` = status and `fill` = build).
//   * hard per-fill ceiling: a single fill may move at most FAST_MAX_SOL_PER_FILL SOL out of it (lamports
//     bound at build and again on the signed bytes), on top of the signer's USD caps which this lane enforces
//     even on devnet (task-1363: "per-trade and daily caps enforced signer-side").
//   * the seed lives in ~/.dexterm/fast-wallet.json at mode 600 and never leaves this module: `get()` returns
//     the public record only; `load()` returns a signer object with a sign method, not the key bytes.
//
// Ed25519 via node:crypto only (no wallet library). The signed wire tx is `shortvec(1) + sig + message`, the
// same shape the executor decodes, compares to the approved message, Ed25519-verifies and re-simulates.

import { createPrivateKey, createPublicKey, randomBytes, sign as edSign, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { base58 } from '../../sources/solana-rpc.ts';
import { decodeTransaction } from '../tx-decode.ts';
import type { SignResult } from '../bridge.ts';

export const FAST_WALLET_NETWORK = 'devnet' as const;
/** Hard ceiling on the SOL a single mandate fill may move out of the fast wallet (devnet-sized). */
export const FAST_MAX_SOL_PER_FILL = 0.05;
export const FAST_MAX_SOL_PER_FILL_LAMPORTS = 50_000_000n;
export const FAST_WALLET_PROVIDER = 'fast-wallet';

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** PKCS#8 DER prefix for an Ed25519 private key (RFC 8410): the 32-byte seed follows. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface FastWalletRecord {
  v: 1;
  network: typeof FAST_WALLET_NETWORK;
  publicKey: string;
  /** base64 of the 32-byte Ed25519 seed. Never returned by get(); never logged (journal.redact scrubs key shapes too). */
  seed: string;
  createdAt: number;
}

/** The public view of the fast wallet (what status lines and the signer channel may carry). */
export interface FastWalletInfo { publicKey: string; network: typeof FAST_WALLET_NETWORK; createdAt: number }

export function defaultFastWalletPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DEXTERM_HOME && env.DEXTERM_HOME.length ? env.DEXTERM_HOME : join(homedir(), '.dexterm');
  return join(home, 'fast-wallet.json');
}

function privateKeyFromSeed(seed: Buffer): KeyObject {
  if (seed.length !== 32) throw new Error('fast wallet: seed must be 32 bytes');
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

function publicKeyOf(priv: KeyObject): string {
  const der = createPublicKey(priv).export({ format: 'der', type: 'spki' }) as Buffer;
  return base58(der.subarray(der.length - 32));
}

function shortvec(n: number): Buffer {
  const out: number[] = [];
  do { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
}

/** The thing that signs: holds the key object, exposes only `publicKey` and `signTransaction`. */
export class FastWalletSigner {
  readonly publicKey: string;
  readonly provider = FAST_WALLET_PROVIDER;
  private readonly key: KeyObject;

  constructor(seed: Buffer) {
    this.key = privateKeyFromSeed(seed);
    this.publicKey = publicKeyOf(this.key);
  }

  /**
   * Sign ONE transaction for the fast wallet itself (same call shape as the Phantom bridge, so the executor's
   * pipeline is unchanged). Refuses: a caller expecting any other key, a transaction whose fee payer / sole
   * required signer is not this wallet, more than one required signature, or undecodable bytes.
   */
  async signTransaction(args: { unsignedTxBase64: string; expectPublicKey?: string; label?: string }): Promise<SignResult> {
    const t0 = Date.now();
    if (args.expectPublicKey !== undefined && args.expectPublicKey !== this.publicKey) throw new Error('fast wallet: refusing to sign for a different public key');
    const tx = decodeTransaction(Buffer.from(args.unsignedTxBase64, 'base64')); // throws on malformed bytes
    if (tx.numRequiredSignatures !== 1) throw new Error(`fast wallet: refusing a transaction with ${tx.numRequiredSignatures} required signatures`);
    if (tx.staticKeys[0] !== this.publicKey) throw new Error('fast wallet: the transaction fee payer is not the fast wallet');
    const sig = edSign(null, tx.message, this.key);
    const wire = Buffer.concat([shortvec(1), sig, tx.message]).toString('base64');
    return { signedTxBase64: wire, provider: FAST_WALLET_PROVIDER, roundTripMs: Date.now() - t0 };
  }
}

/**
 * The on-disk record. `create` writes a fresh key (never overwrites), `get` reads the PUBLIC fields only,
 * `load` returns a signer (or null when there is none / the file is unreadable or not devnet), `remove`
 * deletes the file. Nothing here talks to the network.
 */
export class FastWalletStore {
  readonly path: string;
  constructor(path: string = defaultFastWalletPath()) { this.path = path; }

  exists(): boolean { return existsSync(this.path); }

  private read(): FastWalletRecord | null {
    try {
      if (!existsSync(this.path)) return null;
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<FastWalletRecord>;
      if (raw.v !== 1 || raw.network !== FAST_WALLET_NETWORK) return null;
      if (typeof raw.publicKey !== 'string' || !B58.test(raw.publicKey) || typeof raw.seed !== 'string') return null;
      return { v: 1, network: FAST_WALLET_NETWORK, publicKey: raw.publicKey, seed: raw.seed, createdAt: Number(raw.createdAt) || 0 };
    } catch {
      return null;
    }
  }

  /** Public fields only (no seed). Null when absent/malformed. */
  get(): FastWalletInfo | null {
    const r = this.read();
    return r ? { publicKey: r.publicKey, network: r.network, createdAt: r.createdAt } : null;
  }

  /** A signer over the stored seed, or null. The seed is checked against the stored public key. */
  load(): FastWalletSigner | null {
    const r = this.read();
    if (!r) return null;
    try {
      const signer = new FastWalletSigner(Buffer.from(r.seed, 'base64'));
      return signer.publicKey === r.publicKey ? signer : null;
    } catch {
      return null;
    }
  }

  /**
   * Create a NEW devnet fast wallet. Refuses to overwrite an existing one (remove it first, after draining)
   * and refuses any network but devnet. The caller (the CLI) gates this behind a real TTY keypress.
   */
  create(opts: { network: string; now?: number }): FastWalletInfo {
    if (opts.network !== FAST_WALLET_NETWORK) throw new Error('fast wallet: devnet only — there is no mainnet fast wallet');
    if (this.exists()) throw new Error(`fast wallet: ${this.path} already exists; \`trenchscope wallet fast remove\` first (after draining it)`);
    const seed = randomBytes(32);
    const signer = new FastWalletSigner(seed);
    const rec: FastWalletRecord = { v: 1, network: FAST_WALLET_NETWORK, publicKey: signer.publicKey, seed: seed.toString('base64'), createdAt: opts.now ?? Date.now() };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    try { chmodSync(this.path, 0o600); } catch { /* best effort on platforms without chmod */ }
    return { publicKey: rec.publicKey, network: rec.network, createdAt: rec.createdAt };
  }

  /** Delete the record. Returns true when one existed. */
  remove(): boolean {
    if (!existsSync(this.path)) return false;
    rmSync(this.path, { force: true });
    return true;
  }
}
