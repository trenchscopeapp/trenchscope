// task-1360 — test helpers: deterministic FIXTURE WALLET HISTORIES in the slim RawTx shape, a scripted
// HistorySource the tracker polls, and the SimClock. All synthetic: no key, no wallet, no network, no real
// addresses. TEST-ONLY (lives under test/, never imported by src).

import type { RawTx } from '../src/intel/rules.ts';
import type { HistorySource } from '../src/trade/copy/tracker.ts';
import type { Clock } from '../src/clock.ts';

export class SimClock implements Clock {
  private t: number;
  constructor(start = 1_700_000_000_000) { this.t = start; }
  now(): number { return this.t; }
  advance(ms: number): void { this.t += ms; }
  sleep(): Promise<void> { return Promise.resolve(); }
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** A deterministic base58 44-char address from a seed (never a real key). */
export function addr(seed: number): string { let s = ''; let x = (seed * 2654435761) >>> 0; for (let i = 0; i < 44; i++) { x = (x * 1103515245 + 12345) >>> 0; s += B58[(x >>> 8) % 58]; } return s; }
export function sig(n: number): string { return `SIG${String(n).padStart(6, '0')}${'x'.repeat(80)}`; }

export const LEADER = addr(1);
export const LEADER2 = addr(2);
export const POOL = addr(900);
export const MINT_A = addr(100);
export const MINT_B = addr(101);
export const MINT_C = addr(102);
export const MINT_D = addr(103);
export const MINT_E = addr(104);

export interface TxSpec {
  slot: number;
  /** seconds; omit for an unknown block time */
  blockTime?: number | null;
  sig: string;
  wallet: string;
  /** per-mint token balance before/after for the wallet (raw) */
  tokens?: Array<{ mint: string; pre: bigint; post: bigint }>;
  /** lamports before/after for the wallet */
  lamports: [number, number];
}

/** Build one slim RawTx: the wallet at account 0, the pool at 1, one token account per mint at 2… */
export function mkTx(s: TxSpec): RawTx {
  const toks = s.tokens ?? [];
  const keys = [{ pubkey: s.wallet, signer: true }, { pubkey: POOL, signer: false }, ...toks.map((_, i) => ({ pubkey: addr(5000 + s.slot * 7 + i), signer: false }))];
  const pre = [s.lamports[0], 1_000_000_000_000, ...toks.map(() => 2_039_280)];
  const post = [s.lamports[1], 1_000_000_000_000 - (s.lamports[1] - s.lamports[0]), ...toks.map(() => 2_039_280)];
  return {
    slot: s.slot,
    blockTime: s.blockTime === undefined ? 1_700_000_000 + s.slot : s.blockTime,
    transactionIndex: 0,
    transaction: { signatures: [s.sig], message: { accountKeys: keys } },
    meta: {
      preBalances: pre, postBalances: post,
      preTokenBalances: toks.map((t, i) => ({ accountIndex: 2 + i, mint: t.mint, owner: s.wallet, uiTokenAmount: { amount: t.pre.toString() } })),
      postTokenBalances: toks.map((t, i) => ({ accountIndex: 2 + i, mint: t.mint, owner: s.wallet, uiTokenAmount: { amount: t.post.toString() } })),
    },
  };
}

const SOL = 1_000_000_000;

/**
 * The LEADER's fixture history (oldest first):
 *   A: buy 1.0 SOL → 1,000,000; sell half for 0.9; sell rest for 0.8   → realised +0.7 SOL, closed, WIN
 *   B: buy 0.5 SOL → 500,000; sell all for 0.2                          → realised −0.3 SOL, closed, LOSS
 *   C: airdrop 300,000 (no SOL leg, flagged); sell all for 0.3          → realised +0.3 SOL, closed, WIN (flagged)
 *   D: buy 0.25 SOL → 100,000; still held                               → open
 *   E: token-swap leg (B→E) not priced … then E transferred out         → transfer, no PnL
 * Lamports start at 10 SOL; every tx pays a 5,000-lamport fee on top of its leg.
 */
export function leaderHistory(): RawTx[] {
  let bal = 10 * SOL;
  const step = (leg: number) => { const pre = bal; bal = bal + leg - 5_000; return [pre, bal] as [number, number]; };
  return [
    mkTx({ slot: 100, sig: sig(1), wallet: LEADER, tokens: [{ mint: MINT_A, pre: 0n, post: 1_000_000n }], lamports: step(-1.0 * SOL) }),
    mkTx({ slot: 120, sig: sig(2), wallet: LEADER, tokens: [{ mint: MINT_B, pre: 0n, post: 500_000n }], lamports: step(-0.5 * SOL) }),
    mkTx({ slot: 140, sig: sig(3), wallet: LEADER, tokens: [{ mint: MINT_A, pre: 1_000_000n, post: 500_000n }], lamports: step(0.9 * SOL) }),
    mkTx({ slot: 160, sig: sig(4), wallet: LEADER, tokens: [{ mint: MINT_C, pre: 0n, post: 300_000n }], lamports: step(0) }),
    mkTx({ slot: 180, sig: sig(5), wallet: LEADER, tokens: [{ mint: MINT_B, pre: 500_000n, post: 0n }], lamports: step(0.2 * SOL) }),
    mkTx({ slot: 200, sig: sig(6), wallet: LEADER, tokens: [{ mint: MINT_A, pre: 500_000n, post: 0n }], lamports: step(0.8 * SOL) }),
    mkTx({ slot: 220, sig: sig(7), wallet: LEADER, tokens: [{ mint: MINT_C, pre: 300_000n, post: 0n }], lamports: step(0.3 * SOL) }),
    mkTx({ slot: 240, sig: sig(8), wallet: LEADER, tokens: [{ mint: MINT_D, pre: 0n, post: 100_000n }], lamports: step(-0.25 * SOL) }),
    mkTx({ slot: 260, sig: sig(9), wallet: LEADER, tokens: [{ mint: MINT_D, pre: 100_000n, post: 100_000n }, { mint: MINT_E, pre: 0n, post: 50_000n }], lamports: step(0) }),
    mkTx({ slot: 280, sig: sig(10), wallet: LEADER, tokens: [{ mint: MINT_E, pre: 50_000n, post: 0n }], lamports: step(0) }),
  ];
}

/** A scripted history source: `push()` appends newer txs between polls; pages are served newest first. */
export class FakeHistory implements HistorySource {
  readonly calls: Array<{ address: string; limit: number; sortOrder?: string }> = [];
  private readonly byWallet = new Map<string, RawTx[]>();
  fail: string | null = null;
  private readonly clock: Clock;
  constructor(clock: Clock, seed: Record<string, RawTx[]> = {}) { this.clock = clock; for (const [w, txs] of Object.entries(seed)) this.byWallet.set(w, [...txs]); }
  push(wallet: string, ...txs: RawTx[]): void { const L = this.byWallet.get(wallet) ?? []; L.push(...txs); this.byWallet.set(wallet, L); }
  async transactions(address: string, opts: { limit: number; sortOrder?: 'asc' | 'desc'; paginationToken?: string }) {
    this.calls.push({ address, limit: opts.limit, sortOrder: opts.sortOrder });
    if (this.fail) throw new Error(this.fail);
    const all = [...(this.byWallet.get(address) ?? [])].sort((a, b) => a.slot - b.slot);
    const ordered = opts.sortOrder === 'desc' ? all.reverse() : all;
    const data = ordered.slice(0, opts.limit);
    return { data, paginationToken: ordered.length > opts.limit ? 'more' : null, fetchedAt: this.clock.now() };
  }
}
