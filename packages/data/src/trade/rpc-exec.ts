// trenchscope T1 — the ONLY place that can submit a transaction (SPEC §6.1 steps 2/5). Kept out of the
// read-only `sources/solana-rpc.ts` (which refuses non-read methods) so the broadcast path is small,
// explicit and auditable. It simulates against the user's RPC, submits an already-signed transaction
// (trenchscope never signs), and confirms it. It holds no keys.
//
// DEVNET is the default RPC. Mainnet is only used when the caps allow it (--mainnet).

import type { Clock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import type { HttpClient } from '../http.ts';
import type { TradeNetwork } from './caps.ts';

export const DEVNET_RPC = 'https://api.devnet.solana.com';
export const MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

/**
 * Hostnames that are devnet/testnet by construction. EXACT matches only (round 2, re-verify MEDIUM #5):
 * the old substring test took `https://mainnet.helius-rpc.com/?api-key=devnet-team-key` for devnet and
 * dropped every USD cap. Any other host — mainnet, a vendor URL, localhost, an unparseable string — is
 * classified MAINNET so the caps apply by default. A deployment that really runs a private devnet can
 * say so explicitly via `TradeRpc({ network: 'devnet' })`.
 */
export const DEVNET_HOSTS: ReadonlySet<string> = new Set([
  'api.devnet.solana.com',
  'api.testnet.solana.com',
  'devnet.helius-rpc.com',
]);

/**
 * DEFECT 4 / round 2: classify a trade from the RPC endpoint it will actually talk to, NOT from a
 * free-text "network" label and NOT from a substring. The URL is PARSED and only an exact known
 * devnet/testnet hostname is devnet. Everything else (including an empty or malformed URL) is mainnet.
 */
export function rpcNetwork(url: string | undefined | null, explicit?: TradeNetwork | null): TradeNetwork {
  if (explicit === 'devnet' || explicit === 'mainnet') return explicit;
  if (typeof url !== 'string' || url.length === 0) return 'mainnet';
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:' && u.protocol !== 'wss:' && u.protocol !== 'ws:') return 'mainnet';
    host = u.hostname.toLowerCase();
  } catch {
    return 'mainnet';
  }
  return DEVNET_HOSTS.has(host) ? 'devnet' : 'mainnet';
}

/**
 * Only these JSON-RPC methods are reachable; `simulateTransaction` is the gate before any submit.
 * task-1337 adds the two READ methods the token-balance diff needs (the wallet's token accounts before
 * the trade, and address-lookup-table contents); still nothing that moves funds besides `sendTransaction`.
 */
const ALLOWED = new Set(['simulateTransaction', 'sendTransaction', 'getLatestBlockhash', 'getSignatureStatuses', 'getBalance', 'getMultipleAccounts', 'getTokenAccountsByOwner', 'requestAirdrop']);

export interface SimResult {
  ok: boolean;
  err: unknown | null;
  logs: string[] | null;
  unitsConsumed: number | null;
  /**
   * Post-simulation lamport balances for the `accounts` the caller asked about, in order; an entry is
   * null when the node returned no account (e.g. it does not exist). null when none were requested.
   */
  accounts: (bigint | null)[] | null;
  /**
   * task-1337: the post-simulation account DATA (raw bytes) for the same `accounts`, in order; null per
   * entry when the node returned no account, null overall when none were requested or the node sent no
   * data. The executor parses SPL token accounts out of this to diff token balances.
   */
  accountsData: (Buffer | null)[] | null;
}

/** A read-only account snapshot (getMultipleAccounts). */
export interface AccountInfo { lamports: bigint; owner: string; data: Buffer }

export interface ConfirmResult {
  signature: string;
  confirmed: boolean;
  err: unknown | null;
  slot: number | null;
}

interface RpcEnvelope<T> { result?: T; error?: { code?: number; message?: string; data?: unknown } }

/** The node's `[base64, 'base64']` (or a bare base64 string) account data → bytes; null when absent/odd. */
export function decodeAccountData(data: unknown): Buffer | null {
  const s = Array.isArray(data) ? data[0] : data;
  if (typeof s !== 'string') return null;
  if (Array.isArray(data) && data[1] !== undefined && data[1] !== 'base64') return null;
  return Buffer.from(s, 'base64');
}

/**
 * The node ANSWERED with a JSON-RPC error. For `sendTransaction` this is a DEFINITE pre-broadcast
 * rejection (preflight failure, bad blockhash, malformed tx): nothing reached the network, so the
 * executor may refund the daily reservation. Any other failure (timeout, reset, 5xx) is a transport
 * error whose outcome is UNKNOWN and must not be refunded (round 2, re-verify MEDIUM #4).
 */
export class RpcRejectedError extends Error {
  readonly method: string;
  readonly code: number | null;
  readonly data: unknown;
  constructor(method: string, message: string, code: number | null, data: unknown) {
    super(`rpc ${method}: ${message}`);
    this.name = 'RpcRejectedError';
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

export class TradeRpc {
  private readonly http: HttpClient;
  readonly url: string;
  /** The classified network of `url` (or the explicit config). The executor caps by THIS. */
  readonly network: TradeNetwork;
  private readonly meta = { source: 'solana-rpc' as const, bucket: 'solana-rpc' };
  private readonly clock: Clock;

  constructor(http: HttpClient, opts: { url?: string; clock?: Clock; network?: TradeNetwork } = {}) {
    this.http = http;
    this.url = opts.url ?? DEVNET_RPC;
    this.network = rpcNetwork(this.url, opts.network ?? null);
    this.clock = opts.clock ?? systemClock;
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    if (!ALLOWED.has(method)) throw new Error(`refusing RPC method ${method}`);
    const r = await this.http.postJson<RpcEnvelope<T>>(this.url, { jsonrpc: '2.0', id: 1, method, params }, this.meta);
    if (r.data.error) throw new RpcRejectedError(method, r.data.error.message ?? 'error', typeof r.data.error.code === 'number' ? r.data.error.code : null, r.data.error.data);
    if (r.data.result === undefined) throw new Error(`rpc ${method}: no result`);
    return r.data.result;
  }

  /**
   * Simulate a (possibly unsigned) base64 transaction with `replaceRecentBlockhash` + `sigVerify:false`
   * so the plan can be checked before the user signs. A non-null `err` means the trade must be refused.
   * `opts.accounts` asks the node for the POST-simulation state of those addresses (their lamports are
   * what the executor compares against the pre-balance to learn how much SOL the tx really moves).
   */
  async simulate(txBase64: string, opts: { accounts?: string[] } = {}): Promise<SimResult> {
    const cfg: Record<string, unknown> = { encoding: 'base64', replaceRecentBlockhash: true, sigVerify: false, commitment: 'confirmed' };
    const want = opts.accounts ?? [];
    if (want.length > 0) cfg.accounts = { encoding: 'base64', addresses: want };
    const res = await this.call<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number; accounts?: ({ lamports?: number; data?: unknown } | null)[] | null } }>(
      'simulateTransaction', [txBase64, cfg],
    );
    const v = res.value;
    let accounts: (bigint | null)[] | null = null;
    let accountsData: (Buffer | null)[] | null = null;
    if (want.length > 0) {
      accounts = want.map((_, i) => {
        const a = v.accounts?.[i];
        return a && typeof a.lamports === 'number' && Number.isFinite(a.lamports) ? BigInt(Math.trunc(a.lamports)) : null;
      });
      if (Array.isArray(v.accounts)) accountsData = want.map((_, i) => decodeAccountData(v.accounts?.[i]?.data));
    }
    return { ok: v.err === null || v.err === undefined, err: v.err ?? null, logs: v.logs ?? null, unitsConsumed: typeof v.unitsConsumed === 'number' ? v.unitsConsumed : null, accounts, accountsData };
  }

  /**
   * task-1363: devnet faucet (`requestAirdrop`) for the capped fast wallet — refused by classification on any
   * non-devnet endpoint (mainnet nodes reject it anyway). Returns the airdrop signature.
   */
  async airdrop(pubkey: string, lamports: bigint): Promise<string> {
    if (this.network !== 'devnet') throw new Error('requestAirdrop runs only against a devnet RPC endpoint');
    if (!(lamports > 0n)) throw new Error('airdrop needs a positive lamport amount');
    return this.call<string>('requestAirdrop', [pubkey, Number(lamports)]);
  }

  /** Lamport balance of an account (read-only `getBalance`). Used for the pre-simulation balance. */
  async balance(pubkey: string): Promise<bigint> {
    const res = await this.call<{ value: number }>('getBalance', [pubkey, { commitment: 'confirmed' }]);
    if (typeof res.value !== 'number' || !Number.isFinite(res.value)) throw new Error('rpc getBalance: bad value');
    return BigInt(Math.trunc(res.value));
  }

  /**
   * task-1337: read-only snapshots of several accounts (`getMultipleAccounts`, base64). null per entry
   * when the account does not exist. Used for the token-account PRE-balances the simulation diff
   * compares against, and to read address-lookup tables so every account a v0 transaction can touch is
   * known. Throws on a malformed answer (the executor fails closed).
   */
  async accountsInfo(pubkeys: string[]): Promise<(AccountInfo | null)[]> {
    if (pubkeys.length === 0) return [];
    const out: (AccountInfo | null)[] = [];
    for (let i = 0; i < pubkeys.length; i += 100) { // the node caps one call at 100 accounts
      const chunk = pubkeys.slice(i, i + 100);
      const res = await this.call<{ value: ({ lamports?: number; owner?: string; data?: unknown } | null)[] }>('getMultipleAccounts', [chunk, { encoding: 'base64', commitment: 'confirmed' }]);
      if (!Array.isArray(res.value) || res.value.length !== chunk.length) throw new Error('rpc getMultipleAccounts: bad value');
      for (const a of res.value) {
        if (a === null) { out.push(null); continue; }
        const data = decodeAccountData(a.data);
        if (typeof a.lamports !== 'number' || typeof a.owner !== 'string' || data === null) throw new Error('rpc getMultipleAccounts: malformed account');
        out.push({ lamports: BigInt(Math.trunc(a.lamports)), owner: a.owner, data });
      }
    }
    return out;
  }

  /**
   * task-1337: every token account `owner` holds under `programId` (`getTokenAccountsByOwner`, base64).
   * These are the accounts a hostile route could drain; the executor watches their balances through the
   * simulation. Throws on a malformed answer (fail closed).
   */
  async tokenAccountsByOwner(owner: string, programId: string): Promise<{ pubkey: string; data: Buffer }[]> {
    const res = await this.call<{ value: { pubkey?: string; account?: { data?: unknown } }[] }>('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'base64', commitment: 'confirmed' }]);
    if (!Array.isArray(res.value)) throw new Error('rpc getTokenAccountsByOwner: bad value');
    return res.value.map((e) => {
      const data = decodeAccountData(e.account?.data);
      if (typeof e.pubkey !== 'string' || data === null) throw new Error('rpc getTokenAccountsByOwner: malformed entry');
      return { pubkey: e.pubkey, data };
    });
  }

  /** A recent blockhash for a transaction trenchscope builds itself (the devnet probe). Read-only. */
  async latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const res = await this.call<{ value: { blockhash?: string; lastValidBlockHeight?: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const v = res.value;
    if (!v || typeof v.blockhash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v.blockhash)) throw new Error('rpc getLatestBlockhash: bad value');
    return { blockhash: v.blockhash, lastValidBlockHeight: typeof v.lastValidBlockHeight === 'number' ? v.lastValidBlockHeight : 0 };
  }

  /** Broadcast an already-signed base64 transaction. Returns the signature. */
  async submit(signedTxBase64: string): Promise<string> {
    return this.call<string>('sendTransaction', [signedTxBase64, { encoding: 'base64', skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed' }]);
  }

  /**
   * One status lookup for a signature we already know (from the signed bytes). Returns null when the
   * node has not seen it. Used after a transport error on submit to learn whether the send landed.
   */
  async signatureStatus(signature: string): Promise<{ confirmationStatus: string | null; err: unknown; slot: number | null } | null> {
    const res = await this.call<{ value: ({ confirmationStatus?: string; err: unknown; slot?: number } | null)[] }>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
    const st = res.value?.[0];
    if (!st) return null;
    return { confirmationStatus: st.confirmationStatus ?? null, err: st.err ?? null, slot: st.slot ?? null };
  }

  /** Poll signature status until confirmed/finalized, a chain error, or the bound elapses. */
  async confirm(signature: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<ConfirmResult> {
    const deadline = this.clock.now() + (opts.timeoutMs ?? 60_000);
    const interval = opts.intervalMs ?? 2_000;
    for (;;) {
      const res = await this.call<{ value: ({ confirmationStatus?: string; err: unknown; slot?: number } | null)[] }>('getSignatureStatuses', [[signature], { searchTransactionHistory: false }]);
      const st = res.value[0];
      if (st) {
        if (st.err) return { signature, confirmed: false, err: st.err, slot: st.slot ?? null };
        if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') {
          return { signature, confirmed: true, err: null, slot: st.slot ?? null };
        }
      }
      if (this.clock.now() >= deadline) return { signature, confirmed: false, err: 'confirmation timed out', slot: null };
      await this.clock.sleep(interval);
    }
  }
}
