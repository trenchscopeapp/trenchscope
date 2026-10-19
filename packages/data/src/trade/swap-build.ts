// trenchscope T1 — Jupiter keyless SWAP BUILD (SPEC §6.1 step 2). Separate file from the T0 quote-only
// `sources/jupiter-swap.ts` ON PURPOSE: that file is provably unable to reach a signable transaction
// (the verifier key-scan relies on it), so the tx-building step lives here, clearly T1-gated.
//
// Flow: GET /swap/v1/quote (keyless, raw) -> POST /swap/v1/swap { quoteResponse, userPublicKey } ->
// a base64 VersionedTransaction. trenchscope does NOT sign it; it hands the bytes to the wallet bridge.
//
// IMPORTANT (design constraint): Jupiter's quote/swap liquidity is
// MAINNET-only — there is no Jupiter devnet. So a Jupiter swap plan is a MAINNET plan. With the
// default devnet caps the signer refuses to sign it (mainnet-not-enabled): the default experience is
// a read-only plan + simulation (SPEC §6.10 "mainnet read-only quotes/sims, confirm disabled").
// Enabling a real swap needs --mainnet + the USD caps. The devnet signer/bridge plumbing is proven
// separately with a wallet self-transfer (scripts/phantom-devnet.md). No key ever enters dexterm.

import type { HttpClient } from '../http.ts';
import { JUP_SWAP_HOSTS, JupiterHosts, type JupiterRetryOptions, type QuoteRequest } from '../sources/jupiter-swap.ts';

const BUILD = { source: 'jupiter-swap', bucket: 'jupiter' } as const;

/**
 * task-1368: a raw quote fetched this recently for the SAME request is reused instead of re-fetched. The LIVE
 * ticket's preview (`quote` through the signer), the signer's own re-quote at ⏎ and the build then cost the
 * per-IP keyless budget two calls, not three, and are paced by ONE limiter (the signer's). The executor still
 * binds whatever quote it gets to the order (mints, mode, exact amount) and simulates the built transaction.
 */
export const QUOTE_REUSE_MS = 15_000;

/** The raw quote object Jupiter returns; passed back verbatim to /swap (Jupiter requires the exact object). */
export type RawQuote = Record<string, unknown> & { inAmount?: string; outAmount?: string; priceImpactPct?: string };

export interface BuiltSwap {
  /** base64-encoded unsigned VersionedTransaction, ready for the wallet to sign. */
  swapTransactionBase64: string;
  lastValidBlockHeight: number | null;
  prioritizationFeeLamports: number | null;
  /** The raw quote used to build it (for display + plan-hash cross-checks). */
  quote: RawQuote;
}

export class JupiterSwapBuild {
  private readonly http: HttpClient;
  private readonly hosts: JupiterHosts;
  /** The last raw quote per request key, for QUOTE_REUSE_MS. One entry per distinct order is plenty. */
  private readonly recent = new Map<string, { raw: RawQuote; at: number }>();

  constructor(http: HttpClient, hosts: readonly string[] = JUP_SWAP_HOSTS, retry: JupiterRetryOptions = {}) {
    this.http = http;
    this.hosts = new JupiterHosts(hosts, { clock: http.clock, bucketPausedMs: () => http.pausedFor(BUILD.bucket), sourceUnavailableMs: () => http.unavailableFor(BUILD.source), ...retry });
  }

  get host(): string { return this.hosts.host; }

  /**
   * Fetch the RAW quote object (needed verbatim by /swap). Keyless, read-only. A quote for the same request
   * fetched within QUOTE_REUSE_MS is returned again (`fresh: false` forces a network quote).
   */
  async quoteRaw(req: QuoteRequest, signal?: AbortSignal, opts: { reuseMs?: number } = {}): Promise<RawQuote> {
    if (!(req.amount > 0n)) throw new Error('quote amount must be a positive integer of base units');
    if (req.inputMint === req.outputMint) throw new Error('quote needs two different mints');
    const params = new URLSearchParams({
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      amount: req.amount.toString(),
      slippageBps: String(Math.max(0, Math.round(req.slippageBps))),
      swapMode: req.mode ?? 'ExactIn',
    });
    const key = params.toString();
    const reuseMs = opts.reuseMs ?? QUOTE_REUSE_MS;
    const now = this.http.clock.now();
    const hit = this.recent.get(key);
    if (hit && reuseMs > 0 && now - hit.at <= reuseMs) return hit.raw;
    const r = await this.getJson<RawQuote>(`/swap/v1/quote?${key}`, signal);
    if (!r || typeof r !== 'object' || r.inAmount === undefined || r.outAmount === undefined) {
      throw new Error('empty or malformed quote');
    }
    this.recent.clear();
    this.recent.set(key, { raw: r, at: this.http.clock.now() });
    return r;
  }

  /** Age in ms of the reusable quote for this request, or null when none is held. */
  quoteAge(req: QuoteRequest): number | null {
    const key = new URLSearchParams({
      inputMint: req.inputMint, outputMint: req.outputMint, amount: req.amount.toString(),
      slippageBps: String(Math.max(0, Math.round(req.slippageBps))), swapMode: req.mode ?? 'ExactIn',
    }).toString();
    const hit = this.recent.get(key);
    return hit ? this.http.clock.now() - hit.at : null;
  }

  /**
   * Build an unsigned swap transaction for `userPublicKey` from a raw quote. KEYLESS. The returned
   * bytes are an unsigned VersionedTransaction; trenchscope never signs — the wallet bridge does.
   */
  async buildSwap(args: { quote: RawQuote; userPublicKey: string; signal?: AbortSignal }): Promise<BuiltSwap> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(args.userPublicKey)) throw new Error('buildSwap needs a base58 public key');
    const body = {
      quoteResponse: args.quote,
      userPublicKey: args.userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      // Jupiter managed landing / priority-fee defaults; trenchscope never sets a fee it cannot cap.
    };
    const r = await this.postJson<{ swapTransaction?: string; lastValidBlockHeight?: number; prioritizationFeeLamports?: number }>(`/swap/v1/swap`, body, args.signal);
    const tx = r?.swapTransaction;
    if (typeof tx !== 'string' || tx.length === 0) throw new Error('swap build returned no transaction');
    if (!/^[A-Za-z0-9+/=]+$/.test(tx)) throw new Error('swap transaction is not base64');
    return {
      swapTransactionBase64: tx,
      lastValidBlockHeight: typeof r.lastValidBlockHeight === 'number' ? r.lastValidBlockHeight : null,
      prioritizationFeeLamports: typeof r.prioritizationFeeLamports === 'number' ? r.prioritizationFeeLamports : null,
      quote: args.quote,
    };
  }

  /** task-1368: 401/403 → sticky failover; 429/5xx/transport → alternate host + bounded retry (JupiterHosts). */
  private async getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    const r = await this.hosts.run((host) => this.http.getJson<T>(`${host}${path}`, BUILD, undefined, signal), signal);
    return r.data;
  }

  private async postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const r = await this.hosts.run((host) => this.http.postJson<T>(`${host}${path}`, body, BUILD, undefined, signal), signal);
    return r.data;
  }
}
