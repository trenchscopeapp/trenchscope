// task-1310 round 2 — shared helpers for the live-executor tests: REAL Solana wire-format transactions
// (legacy + v0) built by hand, signed with THROWAWAY in-memory Ed25519 keys, plus a fake TradeRpc that
// reports pre/post balances. No network, no real wallet, no funds, nothing ever reaches a chain.
import { generateKeyPairSync, sign as edSign, randomBytes, type KeyObject } from 'node:crypto';
import { base58 } from '../src/sources/solana-rpc.ts';
import {
  SYSTEM_PROGRAM, TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM, JUPITER_V6_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, LIGHTHOUSE_PROGRAM, WSOL_MINT,
  associatedTokenAddress,
} from '../src/trade/tx-decode.ts';
import { base58Decode } from '../src/sources/pda.ts';
import type { SolUsdSample } from '../src/trade/sol-usd.ts';

export interface Keypair { pub: Buffer; priv: KeyObject; address: string }

/** A throwaway Ed25519 keypair standing in for a wallet; `pub` is the raw 32-byte public key. */
export function keypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const pub = Buffer.from(der.subarray(der.length - 32));
  return { pub, priv: privateKey, address: base58(pub) };
}

export function shortvec(n: number): Buffer {
  const out: number[] = [];
  do { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
}

export const randomKey = (): Buffer => randomBytes(32);
const toKey = (k: Buffer | string): Buffer => (typeof k === 'string' ? Buffer.from(base58Decode(k)) : k);

export interface IxSpec {
  /** Program id (base58 or raw key). */
  program: Buffer | string;
  /** Account keys in instruction order (base58 or raw). */
  accounts: (Buffer | string)[];
  data: Buffer;
}

export interface BuiltTx {
  /** Unsigned wire tx (zero signature slot), base64 — what `/swap` would return. */
  unsigned: string;
  message: Buffer;
  staticKeys: string[];
  /** Sign the message with a keypair and return the signed wire tx, base64. */
  sign(kp: Keypair): string;
}

/** Token `SyncNative` (17), `CloseAccount` (9), `Approve` (4), `SetAuthority` (6), `ApproveChecked` (13). */
export const tokenIx = (op: number, accounts: (Buffer | string)[], rest: Buffer = Buffer.alloc(0)): IxSpec =>
  ({ program: TOKEN_PROGRAM, accounts, data: Buffer.concat([Buffer.from([op]), rest]) });
/** System `Transfer` (2) of `lamports`; `Assign` (1). */
export const systemTransfer = (from: Buffer | string, to: Buffer | string, lamports: bigint): IxSpec => {
  const d = Buffer.alloc(12); d.writeUInt32LE(2, 0); d.writeBigUInt64LE(lamports, 4);
  return { program: SYSTEM_PROGRAM, accounts: [from, to], data: d };
};
export const systemAssign = (acct: Buffer | string, owner: Buffer | string): IxSpec => {
  const d = Buffer.alloc(36); d.writeUInt32LE(1, 0); toKey(owner).copy(d, 4);
  return { program: SYSTEM_PROGRAM, accounts: [acct], data: d };
};
export const computeBudgetIx = (): IxSpec => ({ program: COMPUTE_BUDGET_PROGRAM, accounts: [], data: Buffer.from([2, 0x40, 0x0d, 0x03, 0x00]) });

/** The test token (USDC) and the quote the executor harness uses; the honest tx is BOUND to these (task-1328). */
export const TEST_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const TEST_OUT_AMOUNT = 2_000_000n;
export const TEST_SLIPPAGE_BPS = 50;

/** ExactIn route args as Jupiter serialises them at the END of the route data (after the route_plan vec). */
export function routeArgs(inAmount: bigint, outAmount: bigint, slippageBps: number, platformFeeBps = 0): Buffer {
  const d = Buffer.alloc(19);
  d.writeBigUInt64LE(inAmount, 0); d.writeBigUInt64LE(outAmount, 8); d.writeUInt16LE(slippageBps, 16); d[18] = platformFeeBps;
  return d;
}

export interface SwapIxOpts {
  /** Override the wrapped-SOL / token ATAs (round-2/3 shape tests use random keys); default = the user's real ATAs. */
  wsolAta?: Buffer; tokenAta?: Buffer; dexProgram?: Buffer;
  /** The bound amounts (default: the harness quote 0.5 SOL → 2_000_000 USDC @ 50 bps). */
  outputMint?: string; outAmount?: bigint; slippageBps?: number; platformFeeBps?: number;
  /** Use the `shared_accounts_route` layout (what the real buy fixture uses) instead of `route`. */
  shared?: boolean;
  /** A platform-fee account instead of the "none" sentinel (the program id). */
  platformFeeAccount?: Buffer;
}

/**
 * The shape of a Jupiter v6 SOL→token swap with wrapAndUnwrapSol: compute budget, create ATA, wrap
 * (transfer + syncNative), the route (CPI into the DEX via Jupiter), close the WSOL account back to the user.
 * task-1328: by default the accounts are the user's REAL associated token accounts and the route args are
 * the quote's amounts, so the tx passes checkSwapBinding like the recorded real fixtures do.
 */
export function jupiterSwapIxs(user: Keypair, lamports: bigint, extra: SwapIxOpts = {}): IxSpec[] {
  const outputMint = extra.outputMint ?? TEST_MINT;
  const wsolAta = extra.wsolAta ?? Buffer.from(base58Decode(associatedTokenAddress(user.address, WSOL_MINT, TOKEN_PROGRAM)));
  const tokenAta = extra.tokenAta ?? Buffer.from(base58Decode(associatedTokenAddress(user.address, outputMint, TOKEN_PROGRAM)));
  const dex = extra.dexProgram ?? Buffer.from(base58Decode('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'));
  const args = routeArgs(lamports, extra.outAmount ?? TEST_OUT_AMOUNT, extra.slippageBps ?? TEST_SLIPPAGE_BPS, extra.platformFeeBps ?? 0);
  const feeAcct: Buffer | string = extra.platformFeeAccount ?? JUPITER_V6_PROGRAM;
  const routePlan = Buffer.concat([Buffer.from([1, 0, 0, 0]), randomBytes(4)]); // vec len 1 + an opaque hop
  const route: IxSpec = extra.shared
    ? { program: JUPITER_V6_PROGRAM, accounts: [TOKEN_PROGRAM, randomKey(), user.pub, wsolAta, randomKey(), randomKey(), tokenAta, randomKey(), randomKey(), feeAcct, JUPITER_V6_PROGRAM, randomKey(), JUPITER_V6_PROGRAM, dex], data: Buffer.concat([Buffer.from('c1209b3341d69c81', 'hex'), Buffer.from([0]), routePlan, args]) }
    : { program: JUPITER_V6_PROGRAM, accounts: [TOKEN_PROGRAM, user.pub, wsolAta, tokenAta, JUPITER_V6_PROGRAM, randomKey(), feeAcct, randomKey(), JUPITER_V6_PROGRAM, dex, randomKey()], data: Buffer.concat([Buffer.from('e517cb977ae3ad2a', 'hex'), routePlan, args]) };
  return [
    computeBudgetIx(),
    { program: ASSOCIATED_TOKEN_PROGRAM, accounts: [user.pub, tokenAta, user.pub, Buffer.from(base58Decode(outputMint)), SYSTEM_PROGRAM, TOKEN_PROGRAM], data: Buffer.from([1]) },
    systemTransfer(user.pub, wsolAta, lamports),
    tokenIx(17, [wsolAta]),
    route,
    tokenIx(9, [wsolAta, user.pub, user.pub]),
  ];
}

/**
 * A token→SOL SELL in the `route` layout (the recorded sell fixture's shape): create the WSOL ATA
 * (idempotent), route from the user's token ATA into the WSOL ATA, close the WSOL ATA back to the user.
 */
export function jupiterSellIxs(user: Keypair, inputMint: string, amountRaw: bigint, outLamports: bigint, slippageBps = TEST_SLIPPAGE_BPS, extra: { sourceAta?: Buffer } = {}): IxSpec[] {
  const wsolAta = Buffer.from(base58Decode(associatedTokenAddress(user.address, WSOL_MINT, TOKEN_PROGRAM)));
  const sourceAta = extra.sourceAta ?? Buffer.from(base58Decode(associatedTokenAddress(user.address, inputMint, TOKEN_PROGRAM)));
  const args = routeArgs(amountRaw, outLamports, slippageBps);
  return [
    computeBudgetIx(),
    { program: ASSOCIATED_TOKEN_PROGRAM, accounts: [user.pub, wsolAta, user.pub, Buffer.from(base58Decode(WSOL_MINT)), SYSTEM_PROGRAM, TOKEN_PROGRAM], data: Buffer.from([1]) },
    { program: JUPITER_V6_PROGRAM, accounts: [TOKEN_PROGRAM, user.pub, sourceAta, wsolAta, JUPITER_V6_PROGRAM, randomKey(), JUPITER_V6_PROGRAM, randomKey(), JUPITER_V6_PROGRAM, randomKey()], data: Buffer.concat([Buffer.from('e517cb977ae3ad2a', 'hex'), Buffer.from([1, 0, 0, 0]), randomBytes(4), args]) },
    tokenIx(9, [wsolAta, user.pub, user.pub]),
  ];
}

/** Phantom-style Lighthouse assertion instruction (AssertAccountDelta = 3) for tail-tolerance tests. */
export const lighthouseIx = (op = 3, accounts: (Buffer | string)[] = [randomKey()]): IxSpec => ({ program: LIGHTHOUSE_PROGRAM, accounts, data: Buffer.concat([Buffer.from([op]), randomBytes(8)]) });

/**
 * Build a transaction. Static keys: fee payer first (the user), then every other account key in first-
 * seen order, then the programs (read-only). `lookups` adds v0 address-lookup-table entries.
 */
export function buildTx(opts: {
  feePayer: Buffer | string;
  ixs: IxSpec[];
  version?: 'legacy' | 0;
  lookups?: { table: Buffer; writable: number[]; readonly: number[] }[];
  blockhash?: Buffer;
  numRequiredSignatures?: number;
}): BuiltTx {
  const version = opts.version ?? 0;
  const payer = toKey(opts.feePayer);
  const keys: Buffer[] = [payer];
  const programs: Buffer[] = [];
  const add = (list: Buffer[], k: Buffer) => { if (!keys.some((x) => x.equals(k)) && !list.some((x) => x.equals(k))) list.push(k); };
  for (const ix of opts.ixs) for (const a of ix.accounts) add(keys, toKey(a));
  for (const ix of opts.ixs) { const p = toKey(ix.program); if (!keys.some((x) => x.equals(p))) add(programs, p); }
  const all = [...keys, ...programs];
  const index = (k: Buffer) => all.findIndex((x) => x.equals(k));
  const header = Buffer.from([opts.numRequiredSignatures ?? 1, 0, programs.length]);
  const parts: Buffer[] = [];
  if (version === 0) parts.push(Buffer.from([0x80]));
  parts.push(header, shortvec(all.length), ...all, opts.blockhash ?? randomBytes(32), shortvec(opts.ixs.length));
  for (const ix of opts.ixs) {
    const accIdx = ix.accounts.map((a) => index(toKey(a)));
    parts.push(Buffer.from([index(toKey(ix.program))]), shortvec(accIdx.length), Buffer.from(accIdx), shortvec(ix.data.length), ix.data);
  }
  if (version === 0) {
    const lk = opts.lookups ?? [];
    parts.push(shortvec(lk.length));
    for (const l of lk) parts.push(l.table, shortvec(l.writable.length), Buffer.from(l.writable), shortvec(l.readonly.length), Buffer.from(l.readonly));
  }
  const message = Buffer.concat(parts);
  const nSig = opts.numRequiredSignatures ?? 1;
  const wire = (sigs: Buffer[]) => Buffer.concat([shortvec(sigs.length), ...sigs, message]).toString('base64');
  return {
    unsigned: wire(Array.from({ length: nSig }, () => Buffer.alloc(64))),
    message,
    staticKeys: all.map((k) => base58(k)),
    sign: (kp) => wire([edSign(null, message, kp.priv), ...Array.from({ length: nSig - 1 }, () => Buffer.alloc(64))]),
  };
}

/** Re-wrap an arbitrary message with signatures (for tampering tests). */
export function wireWith(message: Buffer, sigs: Buffer[]): string {
  return Buffer.concat([shortvec(sigs.length), ...sigs, message]).toString('base64');
}
export const signMessage = (kp: Keypair, message: Buffer): Buffer => edSign(null, message, kp.priv);

/** Two fresh, independent, agreeing SOL/USD samples (what the executor needs on mainnet). */
export function solUsdSamples(price: number, now: number, over: Partial<SolUsdSample>[] = []): SolUsdSample[] {
  const base: SolUsdSample[] = [
    { price, fetchedAt: now, source: 'dexscreener' },
    { price: price * 1.001, fetchedAt: now, source: 'geckoterminal' },
  ];
  return base.map((s, i) => ({ ...s, ...(over[i] ?? {}) }));
}

export interface FakeRpcOpts {
  url: string;
  network?: 'devnet' | 'mainnet';
  /** Wallet balance before the tx (lamports). */
  pre?: bigint;
  /** Lamports the simulation says LEFT the wallet (negative = came in). Default 0.5 SOL + 5000 fee. */
  solOut?: bigint | ((txBase64: string, call: number) => bigint | null);
  simOk?: boolean;
  simErr?: unknown;
  /** Omit the `accounts` array from the simulation result (an RPC that cannot report balances). */
  noAccounts?: boolean;
  submit?: (tx: string) => Promise<string>;
  confirm?: (sig: string) => Promise<{ signature: string; confirmed: boolean; err: unknown; slot: number | null }>;
  signatureStatus?: (sig: string) => Promise<{ confirmationStatus: string | null; err: unknown; slot: number | null } | null>;
  /**
   * task-1337: the wallet's token accounts (what getTokenAccountsByOwner returns) — default none, so
   * the token-balance diff has nothing to watch and the older harnesses behave exactly as before.
   */
  tokenAccounts?: FakeTokenAccount[];
  /**
   * The POST-simulation balance of a watched token account: a bigint, `null` for "the node returned no
   * account" (closed), or `undefined` to fall back to the pre-balance (unchanged). `call` is the
   * simulate call index (0 = at build, 1 = at confirm) so a test can be honest at build and hostile at confirm.
   */
  postTokenAmount?: (address: string, call: number) => bigint | null | undefined;
  /** Omit account DATA from the simulation result (a node that reports lamports only). */
  noAccountData?: boolean;
  /** Extra accounts `accountsInfo` knows (address-lookup tables in tests). */
  accounts?: Record<string, { lamports?: bigint; owner: string; data: Buffer }>;
  /** Make getTokenAccountsByOwner / getMultipleAccounts throw (an RPC that cannot answer). */
  readFail?: boolean;
}

export interface FakeTokenAccount { pubkey: string; mint: string; owner: string; amount: bigint; program?: string }

/** Serialize an SPL token account (165-byte base layout; state = Initialized). */
export function tokenAccountData(t: { mint: string; owner: string; amount: bigint }): Buffer {
  const d = Buffer.alloc(165);
  Buffer.from(base58Decode(t.mint)).copy(d, 0);
  Buffer.from(base58Decode(t.owner)).copy(d, 32);
  d.writeBigUInt64LE(t.amount, 64);
  d[108] = 1;
  return d;
}

/** Serialize an address-lookup-table account: 56-byte meta (zeros are fine for the parser) + addresses. */
export function lookupTableData(addresses: (Buffer | string)[]): Buffer {
  return Buffer.concat([Buffer.alloc(56), ...addresses.map((a) => toKey(a))]);
}

export interface FakeRpc {
  url: string; network?: 'devnet' | 'mainnet';
  balance(pk: string): Promise<bigint>;
  simulate(tx: string, opts?: { accounts?: string[] }): Promise<{ ok: boolean; err: unknown; logs: string[]; unitsConsumed: number; accounts: (bigint | null)[] | null; accountsData: (Buffer | null)[] | null }>;
  submit(tx: string): Promise<string>;
  confirm(sig: string): Promise<{ signature: string; confirmed: boolean; err: unknown; slot: number | null }>;
  signatureStatus(sig: string): Promise<{ confirmationStatus: string | null; err: unknown; slot: number | null } | null>;
  accountsInfo(pubkeys: string[]): Promise<({ lamports: bigint; owner: string; data: Buffer } | null)[]>;
  tokenAccountsByOwner(owner: string, programId: string): Promise<{ pubkey: string; data: Buffer }[]>;
  calls: { simulate: number; submit: number; balance: number; status: number; submitted: string[]; accountsInfo: number; tokenAccounts: number; simulatedAccounts: string[][] };
}

export function fakeRpc(o: FakeRpcOpts): FakeRpc {
  const pre = o.pre ?? 10_000_000_000n;
  const calls = { simulate: 0, submit: 0, balance: 0, status: 0, submitted: [] as string[], accountsInfo: 0, tokenAccounts: 0, simulatedAccounts: [] as string[][] };
  const tokens = new Map((o.tokenAccounts ?? []).map((t) => [t.pubkey, t]));
  const rpc: FakeRpc = {
    url: o.url,
    calls,
    async balance() { calls.balance++; return pre; },
    async simulate(tx, opts = {}) {
      const n = calls.simulate++;
      const ok = o.simOk ?? true;
      const out = typeof o.solOut === 'function' ? o.solOut(tx, n) : (o.solOut ?? 500_005_000n);
      const want = opts.accounts ?? [];
      calls.simulatedAccounts.push([...want]);
      const accounts = o.noAccounts || !want.length ? null : want.map(() => (out === null ? null : pre - out));
      // Token accounts the fake knows about come back with their post-balance; anything else as empty data.
      const accountsData = o.noAccounts || o.noAccountData || !want.length ? null : want.map((a) => {
        const t = tokens.get(a);
        if (!t) return Buffer.alloc(0);
        const post = o.postTokenAmount ? o.postTokenAmount(a, n) : undefined;
        if (post === null) return null;
        return tokenAccountData({ ...t, amount: post ?? t.amount });
      });
      return { ok, err: ok ? null : (o.simErr ?? 'blockhash not found'), logs: [], unitsConsumed: 1000, accounts, accountsData };
    },
    async accountsInfo(pubkeys) {
      calls.accountsInfo++;
      if (o.readFail) throw new Error('rpc getMultipleAccounts: down');
      return pubkeys.map((a) => {
        const t = tokens.get(a);
        if (t) return { lamports: 2_039_280n, owner: t.program ?? TOKEN_PROGRAM, data: tokenAccountData(t) };
        const x = o.accounts?.[a];
        return x ? { lamports: x.lamports ?? 1n, owner: x.owner, data: x.data } : null;
      });
    },
    async tokenAccountsByOwner(owner, programId) {
      calls.tokenAccounts++;
      if (o.readFail) throw new Error('rpc getTokenAccountsByOwner: down');
      return [...tokens.values()].filter((t) => t.owner === owner && (t.program ?? TOKEN_PROGRAM) === programId).map((t) => ({ pubkey: t.pubkey, data: tokenAccountData(t) }));
    },
    async submit(tx) { calls.submit++; calls.submitted.push(tx); return o.submit ? o.submit(tx) : `SIG${calls.submit}`; },
    async confirm(sig) { return o.confirm ? o.confirm(sig) : { signature: sig, confirmed: true, err: null, slot: 42 }; },
    async signatureStatus(sig) { calls.status++; return o.signatureStatus ? o.signatureStatus(sig) : null; },
  };
  if (o.network) rpc.network = o.network;
  return rpc;
}
