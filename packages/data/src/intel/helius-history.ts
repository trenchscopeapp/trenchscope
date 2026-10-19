// Helius transaction-history adapter (task-1340, lane W1 of the wallet-intel design). Helius-only enhanced
// RPC: `getTransactionsForAddress` (10 credits per call; the credit meter charges it by method name). Used for
// two immutable facts: a wallet's FUNDING SOURCE (its oldest ≤ 3 txs; a wallet's first inflow never changes,
// so the result is cached forever and shared across tokens) and a mint's LAUNCH WINDOW (its oldest succeeded
// txs; pages only extend the tail). Raw transactions are never stored: the rules reduce them to events.
//
// The endpoint URL carries the user's key: it is read from the data layer's configured RPC URL, never from a
// flag, and never printed (HttpError redacts; this adapter logs nothing). Without a Helius endpoint the adapter
// is simply absent and the scan degrades to "funders and launch window need a free Helius key".
import type { HttpClient } from '../http.ts';
import { rpcBodyCheck } from '../sources/solana-rpc.ts';
import type { RawTx, RawTokenBalance } from './rules.ts';

export const HISTORY_METHODS: ReadonlySet<string> = new Set(['getTransactionsForAddress']);

/**
 * Max transaction version we declare support for. Legacy and v0 are all Solana ships today, but Helius's
 * enhanced history has returned a v1 tx in live launch windows (task-1394). We only read static account keys
 * and per-balance owners, which are version-independent, so cap high rather than re-break on the next version.
 */
export const MAX_TX_VERSION = 128;

export interface HistoryPage { data: RawTx[]; paginationToken: string | null; fetchedAt: number }

export interface HistoryOptions {
  limit: number;
  sortOrder?: 'asc' | 'desc';
  paginationToken?: string;
}

export class HeliusHistory {
  private readonly http: HttpClient;
  /** May carry an api-key: never print it. */
  private readonly url: string;
  private readonly meta = { source: 'helius' as const, bucket: 'helius' };

  constructor(http: HttpClient, url: string) {
    this.http = http;
    this.url = url;
  }

  private async call<T>(method: string, params: unknown[]): Promise<{ result: T; fetchedAt: number }> {
    if (!HISTORY_METHODS.has(method)) throw new Error(`refusing non-history RPC method ${method}`);
    const body = { jsonrpc: '2.0', id: 1, method, params };
    const r = await this.http.postJson<{ result?: T; error?: { code?: number; message?: string } }>(this.url, body, this.meta, rpcBodyCheck);
    if (r.data.result === undefined) throw new Error(`rpc ${method}: no result`);
    return { result: r.data.result, fetchedAt: r.fetchedAt };
  }

  /**
   * Succeeded transactions referencing `address`, full jsonParsed, oldest first by default. `limit` ≤ 1000
   * (Helius pages at 100 credits-wise: 10 credits per 100 txs).
   */
  async transactions(address: string, opts: HistoryOptions): Promise<HistoryPage> {
    const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit)));
    const params: Record<string, unknown> = {
      // A single versioned tx in the page whose version exceeds this cap fails the WHOLE request with
      // rpc -32015 ("Transaction version (N) is not supported … maxSupportedTransactionVersion"), which
      // surfaced as "history failed" on live pump.fun launch windows (task-1394: a v1 tx in the first 100).
      // The rules only read static accountKeys (signers are always static, never in a lookup table) and the
      // per-balance owner/mint, so a high cap is safe and forward-compatible across tx versions.
      transactionDetails: 'full', sortOrder: opts.sortOrder ?? 'asc', limit, encoding: 'jsonParsed', maxSupportedTransactionVersion: MAX_TX_VERSION,
      filters: { status: 'succeeded' },
    };
    if (opts.paginationToken) params.paginationToken = opts.paginationToken;
    const { result, fetchedAt } = await this.call<{ data?: RawTx[]; paginationToken?: string | null }>('getTransactionsForAddress', [address, params]);
    return { data: Array.isArray(result.data) ? result.data.map(slimTx) : [], paginationToken: result.paginationToken ?? null, fetchedAt };
  }

  /** A wallet's oldest 3 succeeded txs (funding source + wallet age). 10 credits. */
  firstTxs(wallet: string): Promise<HistoryPage> {
    return this.transactions(wallet, { limit: 3, sortOrder: 'asc' });
  }

  /** The mint's oldest `limit` succeeded txs (launch window). 10 credits per 100. */
  launchWindow(mint: string, limit: number, paginationToken?: string): Promise<HistoryPage> {
    return this.transactions(mint, { limit, sortOrder: 'asc', paginationToken });
  }
}

/**
 * Keep only the fields the rules read (account keys with the signer flag, balances, token balances, slot,
 * time, first signature). A full jsonParsed tx is 10–15 KB; this is ≈ 1–3 KB, which is what the cache stores.
 */
export function slimTx(tx: RawTx): RawTx {
  const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === 'string' ? k : { pubkey: k.pubkey, signer: !!k.signer }));
  const tb = (arr?: RawTokenBalance[]): RawTokenBalance[] => (arr ?? []).map((b) => ({ accountIndex: b.accountIndex, mint: b.mint, owner: b.owner, uiTokenAmount: { amount: b.uiTokenAmount.amount } }));
  return {
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    transactionIndex: tx.transactionIndex ?? null,
    transaction: { signatures: tx.transaction?.signatures?.slice(0, 1) ?? [], message: { accountKeys: keys } },
    meta: tx.meta ? { preBalances: tx.meta.preBalances ?? [], postBalances: tx.meta.postBalances ?? [], preTokenBalances: tb(tx.meta.preTokenBalances), postTokenBalances: tb(tx.meta.postTokenBalances) } : null,
  };
}
