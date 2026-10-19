// trenchscope T1 — the linked-wallet store. trenchscope persists ONLY the public key (an address; never a
// private key, seed or signature). Kept in a small JSON file outside any repo, mode 600 as
// defence-in-depth even though a pubkey is public. The bridge (bridge.ts) produces the pubkey; this
// just remembers it so the status bar can show "linked: <short>" and the executor knows the signer.

import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface LinkedWallet {
  publicKey: string;
  linkedAt: number;
  /** The network the wallet was linked for display purposes ('devnet' | 'mainnet'); optional. */
  network?: string;
}

export function defaultLinkPath(): string {
  return join(homedir(), '.dexterm', 'wallet-link.json');
}

export function shortPubkey(pk: string): string {
  return pk.length > 10 ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : pk;
}

export class WalletLinkStore {
  readonly path: string;
  constructor(path: string = defaultLinkPath()) { this.path = path; }

  /** The linked wallet, or null when none / unreadable / malformed. */
  get(): LinkedWallet | null {
    try {
      if (!existsSync(this.path)) return null;
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<LinkedWallet>;
      if (typeof raw.publicKey !== 'string' || !B58.test(raw.publicKey)) return null;
      return { publicKey: raw.publicKey, linkedAt: Number(raw.linkedAt) || 0, network: typeof raw.network === 'string' ? raw.network : undefined };
    } catch {
      return null;
    }
  }

  /** Persist a linked wallet. Validates the pubkey is base58; refuses anything that is not an address. */
  set(publicKey: string, opts: { network?: string; now?: number } = {}): LinkedWallet {
    if (!B58.test(publicKey)) throw new Error('refusing to store a non-base58 value as a wallet pubkey');
    const rec: LinkedWallet = { publicKey, linkedAt: opts.now ?? Date.now(), network: opts.network };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
    try { chmodSync(this.path, 0o600); } catch { /* best effort on platforms without chmod */ }
    return rec;
  }

  /** Remove the link; returns true when a link existed. */
  clear(): boolean {
    if (!existsSync(this.path)) return false;
    rmSync(this.path, { force: true });
    return true;
  }
}
