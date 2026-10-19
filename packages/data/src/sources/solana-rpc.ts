// Solana JSON-RPC adapter (SPEC §3.1 S6). Keyless, read-only.
// Default endpoint is the public mainnet RPC (heavily rate-limited: "use sparingly");
// any RPC URL can be configured. Only the read methods in READ_METHODS are ever sent.
//   getAccountInfo(mint, base64)          -> SPL / Token-2022 mint: authorities, supply,
//                                            decimals, Token-2022 extension list
//   getTokenLargestAccounts(mint)         -> top 20 token accounts (raw amounts)
//   getMultipleAccounts(accounts, base64) -> token-account owners for those 20
// We decode the binary layouts ourselves (no @solana/* dependency) and use base64,
// which every RPC supports, rather than jsonParsed.
//
// Strict backoff: no retries here. A 429, or a JSON-RPC error that says "too many
// requests" (some RPCs send it with HTTP 200), pauses the bucket with a pause that
// doubles per consecutive 429 (HttpClient) and counts toward health demotion.

import type { BodyCheck, HttpClient } from '../http.ts';
import type { Audit, Holder, HolderLabel, SourceId } from '../model.ts';

export const SOLANA_PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

/** The adapter speaks to either the public RPC (S6) or a Helius endpoint (S9); health and limits differ. */
export type RpcSource = 'solana-rpc' | 'helius';

export const READ_METHODS: ReadonlySet<string> = new Set(['getAccountInfo', 'getMultipleAccounts', 'getTokenLargestAccounts', 'getTokenSupply']);

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MINT_LEN = 82;
const ACCOUNT_LEN = 165; // Token-2022 pads mints to the account size before the extension TLVs
const ACCOUNT_TYPE_MINT = 1;

/** Token-2022 ExtensionType ids (spl-token-2022 `extension/mod.rs`). */
export const TOKEN_2022_EXTENSIONS: Record<number, string> = {
  1: 'transferFeeConfig',
  2: 'transferFeeAmount',
  3: 'mintCloseAuthority',
  4: 'confidentialTransferMint',
  5: 'confidentialTransferAccount',
  6: 'defaultAccountState',
  7: 'immutableOwner',
  8: 'memoTransfer',
  9: 'nonTransferable',
  10: 'interestBearingConfig',
  11: 'cpiGuard',
  12: 'permanentDelegate',
  13: 'nonTransferableAccount',
  14: 'transferHook',
  15: 'transferHookAccount',
  16: 'confidentialTransferFeeConfig',
  17: 'confidentialTransferFeeAmount',
  18: 'metadataPointer',
  19: 'tokenMetadata',
  20: 'groupPointer',
  21: 'tokenGroup',
  22: 'groupMemberPointer',
  23: 'tokenGroupMember',
  24: 'confidentialMintBurn',
  25: 'scaledUiAmountConfig',
  26: 'pausableConfig',
  27: 'pausableAccount',
};

/** Extensions that let an issuer take, block, tax or hook transfers: shown as risk flags. */
export const RISKY_EXTENSIONS: ReadonlySet<string> = new Set([
  'permanentDelegate',
  'transferHook',
  'transferFeeConfig',
  'nonTransferable',
  'defaultAccountState',
  'pausableConfig',
  'mintCloseAuthority',
]);

/**
 * Owners whose token accounts are pool vaults, not holders (SPEC §3.6 allow-list seed).
 * Only program authorities that own the vaults of every pool of that program are listed;
 * PumpSwap / CLMM / Meteora vaults are owned by per-pool PDAs and need Tier 1 labelling.
 */
export const KNOWN_OWNERS: Record<string, HolderLabel> = {
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1': 'LP', // Raydium AMM v4 authority
  GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL: 'LP', // Raydium CPMM authority
};

export interface MintInfo {
  mint: string;
  program: 'spl-token' | 'token-2022' | 'unknown';
  programId: string;
  /** Address while the authority is enabled, null once revoked. */
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Raw supply (base units) as a decimal string (u64 does not fit a double). */
  supply: string;
  decimals: number;
  isInitialized: boolean;
  /** Token-2022 extension names (empty for classic SPL). */
  extensions: string[];
  riskyExtensions: string[];
  source: RpcSource;
  fetchedAt: number;
}

export interface RpcHolder extends Holder {
  /** The token account (what getTokenLargestAccounts returns). */
  tokenAccount: string;
  /** Wallet / program that owns the token account; null if not resolved. */
  owner: string | null;
}

export interface TopHolders {
  mint: string;
  /** Largest first, at most 20 (the RPC's cap). `address` is the owner when resolved. Empty for an aggregate fallback. */
  holders: RpcHolder[];
  /** Share of supply held by the top 10, excluding labelled LP/CEX/bridge accounts (SPEC §3.6). */
  top10Pct: number | null;
  supply: string;
  decimals: number;
  source: SourceId;
  fetchedAt: number;
  /**
   * Keyless aggregate fallback (task-1309): no keyless source serves the ranked top-20 list
   * (getTokenLargestAccounts is throttled/blocked on every free RPC), so when the RPC pool is
   * exhausted we fall back to Jupiter's holder count + top-10 share. `holders` is then empty and
   * the UI shows the count + concentration with a "full list needs a free RPC key" note.
   */
  aggregateOnly?: boolean;
  /** Total holder count when known (Jupiter aggregate); null/undefined from the RPC list path. */
  holderCount?: number | null;
}

interface RpcResponse<T> {
  jsonrpc?: string;
  id?: number | string;
  result?: T;
  error?: { code?: number; message?: string };
}

interface RpcAccount {
  data: [string, string] | string;
  owner: string;
  lamports?: number;
  executable?: boolean;
}

// ---------------------------------------------------------------- decoding

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 (Bitcoin alphabet) encode, used for 32-byte public keys. */
export function base58(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

function accountBytes(acc: RpcAccount): Buffer {
  const [data, enc] = Array.isArray(acc.data) ? acc.data : [acc.data, 'base58'];
  if (enc !== 'base64') throw new Error(`unexpected account encoding ${enc}`);
  return Buffer.from(data, 'base64');
}

function optionPubkey(buf: Buffer, at: number): string | null {
  return buf.readUInt32LE(at) === 1 ? base58(buf.subarray(at + 4, at + 36)) : null;
}

/** Decode an SPL Token / Token-2022 mint account (82-byte base layout + Token-2022 TLV extensions). */
export function decodeMint(mint: string, data: Buffer, programId: string, fetchedAt: number, source: RpcSource = 'solana-rpc'): MintInfo {
  if (data.length < MINT_LEN) throw new Error(`account ${mint} is not a mint (${data.length} bytes)`);
  const program = programId === TOKEN_PROGRAM ? 'spl-token' : programId === TOKEN_2022_PROGRAM ? 'token-2022' : 'unknown';
  const extensions: string[] = [];
  if (data.length > ACCOUNT_LEN && data[ACCOUNT_LEN] === ACCOUNT_TYPE_MINT) {
    let at = ACCOUNT_LEN + 1;
    while (at + 4 <= data.length) {
      const type = data.readUInt16LE(at);
      const len = data.readUInt16LE(at + 2);
      if (type === 0) break; // Uninitialized: rest is padding
      extensions.push(TOKEN_2022_EXTENSIONS[type] ?? `unknown(${type})`);
      at += 4 + len;
    }
  }
  return {
    mint,
    program,
    programId,
    mintAuthority: optionPubkey(data, 0),
    supply: data.readBigUInt64LE(36).toString(),
    decimals: data[44],
    isInitialized: data[45] === 1,
    freezeAuthority: optionPubkey(data, 46),
    extensions,
    riskyExtensions: extensions.filter((e) => RISKY_EXTENSIONS.has(e)),
    source,
    fetchedAt,
  };
}

/** Token account (SPL and Token-2022 share the first 165 bytes): mint, owner, amount. */
export function decodeTokenAccount(data: Buffer): { mint: string; owner: string; amount: bigint } {
  if (data.length < 72) throw new Error(`not a token account (${data.length} bytes)`);
  return { mint: base58(data.subarray(0, 32)), owner: base58(data.subarray(32, 64)), amount: data.readBigUInt64LE(64) };
}

/** Percent of supply, computed in bigint so 18-digit raw amounts keep their precision. */
export function pctOf(amount: bigint, supply: bigint): number {
  if (supply <= 0n) return 0;
  return Number((amount * 10_000_000n) / supply) / 100_000;
}

/** Mint authorities as the shared Audit flags (true = still enabled). */
export function auditFromMint(info: MintInfo, top10Pct: number | null = null): Audit {
  return {
    mint: info.mint,
    mintAuthority: info.mintAuthority !== null,
    freezeAuthority: info.freezeAuthority !== null,
    top10Pct,
    devPct: null,
    devMints: null,
    lpLockedPct: null,
    rugRisks: info.riskyExtensions.map((e) => `token-2022:${e}`),
    rugScore: null,
    source: info.source,
    fetchedAt: info.fetchedAt,
  };
}

/** JSON-RPC errors are failures; rate-limit errors count as 429s (some RPCs send them with HTTP 200). */
export const rpcBodyCheck: BodyCheck = (data) => {
  const err = (data as RpcResponse<unknown> | null)?.error;
  if (!err) return null;
  const message = `rpc error ${err.code ?? '?'}: ${err.message ?? 'unknown'}`;
  const limited = err.code === 429 || /too many requests|rate limit/i.test(err.message ?? '');
  return limited ? { status: 429, error: message } : { error: message };
};

// ---------------------------------------------------------------- adapter

export class SolanaRpc {
  private readonly http: HttpClient;
  /** May carry an api-key: never print it (see rpc-config.ts redactSecrets). */
  readonly url: string;
  readonly source: RpcSource;
  private readonly meta: { source: RpcSource; bucket: string };

  constructor(http: HttpClient, opts: { url?: string; source?: RpcSource; bucket?: string } = {}) {
    this.http = http;
    this.url = opts.url ?? SOLANA_PUBLIC_RPC;
    this.source = opts.source ?? 'solana-rpc';
    // Each pool endpoint gets its own bucket (task-1309) so one endpoint's 429 does not pause the others.
    this.meta = { source: this.source, bucket: opts.bucket ?? this.source };
  }

  private async call<T>(method: string, params: unknown[]): Promise<{ result: T; fetchedAt: number }> {
    if (!READ_METHODS.has(method)) throw new Error(`refusing non-read RPC method ${method}`);
    // Constant id: one request per HTTP call, and recorded fixtures match on replay.
    const body = { jsonrpc: '2.0', id: 1, method, params };
    const r = await this.http.postJson<RpcResponse<T>>(this.url, body, this.meta, rpcBodyCheck);
    if (r.data.result === undefined) throw new Error(`rpc ${method}: no result`);
    return { result: r.data.result, fetchedAt: r.fetchedAt };
  }

  /** Mint/freeze authority, supply, decimals and Token-2022 extensions. */
  async mintInfo(mint: string): Promise<MintInfo> {
    const { result, fetchedAt } = await this.call<{ value: RpcAccount | null }>('getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed' }]);
    if (!result.value) throw new Error(`mint ${mint} not found`);
    return decodeMint(mint, accountBytes(result.value), result.value.owner, fetchedAt, this.source);
  }

  /** Top 20 token accounts; `pct` uses `supply` from mintInfo(). */
  async largestAccounts(mint: string): Promise<{ accounts: { address: string; amount: bigint }[]; fetchedAt: number }> {
    const { result, fetchedAt } = await this.call<{ value: { address: string; amount: string }[] }>('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]);
    return { accounts: result.value.map((a) => ({ address: a.address, amount: BigInt(a.amount) })), fetchedAt };
  }

  /**
   * Raw base64 account data for arbitrary accounts (one getMultipleAccounts call, ≤ 100). Used by the
   * fast lane to seed a first on-chain price (e.g. a pump.fun bonding curve) before the first push.
   * A missing account maps to null; the caller decodes the bytes itself.
   */
  async accountsRaw(accounts: string[], commitment: 'processed' | 'confirmed' | 'finalized' = 'processed'): Promise<{ data: Map<string, string | null>; fetchedAt: number }> {
    const out = new Map<string, string | null>();
    if (accounts.length === 0) return { data: out, fetchedAt: Date.now() };
    const slice = accounts.slice(0, 100);
    const { result, fetchedAt } = await this.call<{ value: (RpcAccount | null)[] }>('getMultipleAccounts', [slice, { encoding: 'base64', commitment }]);
    result.value.forEach((acc, i) => {
      const bytes = acc ? (Array.isArray(acc.data) ? acc.data[0] : null) : null;
      out.set(slice[i], bytes ?? null);
    });
    return { data: out, fetchedAt };
  }

  /**
   * Owner program + raw base64 data for arbitrary accounts (one getMultipleAccounts call, at most 100), in
   * one snapshot. The Shrine chart uses it to verify a PumpSwap pool and its vaults by owner before it
   * trusts their bytes. A missing account maps to null.
   */
  async accountsInfo(accounts: string[], commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed'): Promise<Map<string, { owner: string; data: string } | null>> {
    const out = new Map<string, { owner: string; data: string } | null>();
    if (accounts.length === 0) return out;
    const slice = accounts.slice(0, 100);
    const { result } = await this.call<{ value: (RpcAccount | null)[] }>('getMultipleAccounts', [slice, { encoding: 'base64', commitment }]);
    slice.forEach((address, i) => {
      const acc = result.value?.[i] ?? null;
      const data = acc ? (Array.isArray(acc.data) ? acc.data[0] : null) : null;
      out.set(address, acc && typeof acc.owner === 'string' && typeof data === 'string' ? { owner: acc.owner, data } : null);
    });
    return out;
  }

  /**
   * Account META for arbitrary addresses (task-1340 wallet intel): the owning program (System = a wallet,
   * anything else = program-owned vault / PDA), whether the account exists, lamports. One getMultipleAccounts
   * with a zero-length data slice, so a 100-address call stays a few KB.
   */
  async accountMeta(accounts: string[], commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed'): Promise<Map<string, { programOwner: string | null; exists: boolean; lamports: number; executable?: boolean }>> {
    const out = new Map<string, { programOwner: string | null; exists: boolean; lamports: number; executable?: boolean }>();
    if (accounts.length === 0) return out;
    const slice = accounts.slice(0, 100);
    const { result } = await this.call<{ value: (RpcAccount | null)[] }>('getMultipleAccounts', [slice, { encoding: 'base64', commitment, dataSlice: { offset: 0, length: 0 } }]);
    result.value.forEach((acc, i) => {
      out.set(slice[i], acc ? { programOwner: acc.owner, exists: true, lamports: acc.lamports ?? 0, executable: acc.executable === true } : { programOwner: null, exists: false, lamports: 0, executable: false });
    });
    return out;
  }

  /** Owners of token accounts (one getMultipleAccounts call, ≤ 100 accounts). */
  async tokenAccountOwners(accounts: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (accounts.length === 0) return out;
    const { result } = await this.call<{ value: (RpcAccount | null)[] }>('getMultipleAccounts', [accounts.slice(0, 100), { encoding: 'base64', commitment: 'confirmed' }]);
    result.value.forEach((acc, i) => {
      if (acc) out.set(accounts[i], decodeTokenAccount(accountBytes(acc)).owner);
    });
    return out;
  }

  /**
   * Top-20 holders (SPEC §3.2 keyless): 2 requests (largest accounts + owners), plus
   * getAccountInfo when `info` is not supplied. Owner lookup failing keeps the token
   * accounts as addresses rather than failing the whole call.
   */
  async topHolders(mint: string, opts: { info?: MintInfo; resolveOwners?: boolean } = {}): Promise<TopHolders> {
    const info = opts.info ?? (await this.mintInfo(mint));
    const { accounts: largest, fetchedAt } = await this.largestAccounts(mint);
    let owners = new Map<string, string>();
    if (opts.resolveOwners ?? true) {
      try {
        owners = await this.tokenAccountOwners(largest.map((a) => a.address));
      } catch {
        // keep token accounts; the caller still gets amounts and shares
      }
    }
    const supply = BigInt(info.supply);
    const scale = 10 ** info.decimals;
    const holders = largest.map((a): RpcHolder => {
      const owner = owners.get(a.address) ?? null;
      const label = owner ? KNOWN_OWNERS[owner] : undefined;
      return {
        address: owner ?? a.address,
        tokenAccount: a.address,
        owner,
        amount: Number(a.amount) / scale,
        pct: pctOf(a.amount, supply),
        ...(label ? { label } : {}),
      };
    });
    const excluded = new Set<HolderLabel>(['LP', 'cex', 'bridge']);
    const top10 = holders.filter((h) => !h.label || !excluded.has(h.label)).slice(0, 10);
    return {
      mint,
      holders,
      top10Pct: supply > 0n ? Math.round(top10.reduce((s, h) => s + h.pct, 0) * 1000) / 1000 : null,
      supply: info.supply,
      decimals: info.decimals,
      source: this.source,
      fetchedAt,
    };
  }
}
