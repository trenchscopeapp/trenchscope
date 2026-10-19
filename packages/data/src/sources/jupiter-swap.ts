// Jupiter Swap *Quote* API (SPEC §3.1 S11, §6.1). KEYLESS, READ-ONLY, quote only.
//
// This adapter fetches a swap quote — route, in/out amounts, price impact, fees, slippage —
// and NOTHING else. There is deliberately no /swap build, no /order?taker, no /execute and no
// transaction assembly in this file, so the paper-trading lane (task-1310 T0) can price a fill
// from a live route while being provably unable to reach a signable transaction (SPEC §6.0).
//
//   GET {host}/swap/v1/quote?inputMint=&outputMint=&amount=&slippageBps=&swapMode=
//
// Host order mirrors sources/jupiter.ts: the documented `api.jup.ag` first; on a keyless refusal
// (401/403) switch, for the session, to `lite-api.jup.ag` (still keyless; SPEC §9.1). Shares the
// keyless `jupiter` rate-limit bucket (see SOURCE_BUCKET['jupiter-swap']='jupiter') and so is paced
// and budget-metered exactly like the Tokens/Price calls (free-forever, per-IP quota).

import { HttpError, SourceUnavailableError } from '../http.ts';
import type { HttpClient, JsonResult } from '../http.ts';
import type { Clock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import { numOrNull } from '../util.ts';

export const JUP_SWAP_HOSTS = ['https://api.jup.ag', 'https://lite-api.jup.ag'] as const;
const SWAP = { source: 'jupiter-swap', bucket: 'jupiter' } as const;

// ------------------------------------------------------------------------------------ retry policy (task-1368)
// A live ticket died on `build-failed: HTTP 429 for https://api.jup.ag/swap/v1/swap`: the old adapters
// switched host only on a keyless refusal (401/403), never retried, and a single per-IP 429 on the build killed
// the plan while the shared `jupiter` bucket paused for 30 s (the preview "fetching… forever"). Both hosts answer
// 200 a moment later, so a 429 (or a 5xx / a dropped connection) is TRANSIENT and is handled here, once, for
// the quote adapter AND the build adapter: honour Retry-After, retry with a jittered exponential backoff, try the
// OTHER host (api ⇄ lite-api) for the next attempt, and give up only when the attempt count or the total time
// budget is spent — with a typed error that says exactly when to try again. Nothing here changes what the
// signer checks: it only decides when a keyless HTTP call is re-issued.

/** Retry budget for a keyless Jupiter call: at most this many attempts within this many ms. */
export const JUP_RETRY_MAX_ATTEMPTS = 3;
export const JUP_RETRY_MAX_TOTAL_MS = 10_000;
/** First backoff (doubles per attempt), multiplied by a jitter factor in [0.5, 1.5). */
export const JUP_RETRY_BASE_MS = 1_000;

/**
 * A keyless Jupiter call was rate limited (429) and the retry budget is spent — or the data layer's own health
 * gate is cooling the source down after repeated 429s (SPEC §3.3: two 429s inside a minute → 30 s, doubling).
 * `retryAfterMs` is the honest wait: the largest of the server's Retry-After / reset, the next backoff, the
 * shared bucket's remaining pause and the health cool-down, so a UI that shows "retrying in Ns" and retries then
 * will usually get through. `status` is 429 when the last answer was a 429; 0 when only the cool-down spoke.
 */
export class JupiterRateLimitedError extends Error {
  readonly status: number;
  readonly host: string;
  readonly retryAfterMs: number;
  readonly attempts: number;
  constructor(status: number, host: string, retryAfterMs: number, attempts: number) {
    const s = Math.max(1, Math.ceil(retryAfterMs / 1000));
    super(status === 429
      ? `Jupiter is rate limiting this IP (429 from ${hostnameOf(host)}); retry in ${s}s`
      : `Jupiter calls are paused after repeated rate limits (trenchscope cool-down); retry in ${s}s`);
    this.name = 'JupiterRateLimitedError';
    this.status = status;
    this.host = host;
    this.retryAfterMs = retryAfterMs;
    this.attempts = attempts;
  }
}

function hostnameOf(host: string): string {
  try { return new URL(host).hostname; } catch { return host; }
}

export interface JupiterRetryOptions {
  clock?: Clock;
  maxAttempts?: number;
  maxTotalMs?: number;
  baseBackoffMs?: number;
  /** Jitter source in [0, 1); tests pass a constant. */
  random?: () => number;
  /** Remaining pause (ms) on the shared rate bucket, so the final error reports the real wait. */
  bucketPausedMs?: () => number;
  /** Remaining health-gate cool-down (ms) on the source (0 = available), for the same reason. */
  sourceUnavailableMs?: () => number;
}

/** 429, any 5xx, a dropped connection or a transport timeout: worth another attempt. A caller abort never is. */
export function isTransientJupiterError(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || (err.status >= 500 && err.status <= 599);
  if (err instanceof Error) {
    if (err.name === 'AbortError') return false;
    if (err.name === 'TimeoutError') return true;
    // undici's `fetch failed` (DNS, reset, refused) is a TypeError.
    return err instanceof TypeError;
  }
  return false;
}

/**
 * Host rotation + the retry policy above, shared by the quote and build adapters (one instance per adapter).
 * `run` calls `fn(host)`; on a keyless refusal (401/403) it fails over to the next host for the session (as
 * before); on a transient error it alternates to the other host and retries after `max(Retry-After, backoff)`
 * while the budget allows; otherwise it rethrows. The caller's `signal` cuts a backoff sleep short.
 */
export class JupiterHosts {
  private readonly hosts: readonly string[];
  private index = 0;
  private readonly clock: Clock;
  private readonly maxAttempts: number;
  private readonly maxTotalMs: number;
  private readonly baseMs: number;
  private readonly random: () => number;
  private readonly bucketPausedMs: () => number;
  private readonly sourceUnavailableMs: () => number;

  constructor(hosts: readonly string[] = JUP_SWAP_HOSTS, opts: JupiterRetryOptions = {}) {
    if (hosts.length === 0) throw new Error('JupiterHosts needs at least one host');
    this.hosts = hosts;
    this.clock = opts.clock ?? systemClock;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? JUP_RETRY_MAX_ATTEMPTS);
    this.maxTotalMs = Math.max(0, opts.maxTotalMs ?? JUP_RETRY_MAX_TOTAL_MS);
    this.baseMs = Math.max(0, opts.baseBackoffMs ?? JUP_RETRY_BASE_MS);
    this.random = opts.random ?? Math.random;
    this.bucketPausedMs = opts.bucketPausedMs ?? (() => 0);
    this.sourceUnavailableMs = opts.sourceUnavailableMs ?? (() => 0);
  }

  get host(): string { return this.hosts[this.index]; }

  async run<T>(fn: (host: string, attempt: number) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const started = this.clock.now();
    let attempt = 0;
    let lastStatus = 0;
    for (;;) {
      attempt++;
      const host = this.host;
      try {
        return await fn(host, attempt);
      } catch (err) {
        if (signal?.aborted) throw err;
        // The health gate refused to send (the source is DEGRADED — after two 429s inside a minute, or three
        // failures in a row): report it as the rate-limit wait it is, so the ticket counts down instead of
        // failing with "source jupiter-swap is degraded". Status 429 when this run saw one, else the cool-down form.
        if (err instanceof SourceUnavailableError) {
          const wait = Math.max(this.sourceUnavailableMs(), this.bucketPausedMs(), 1_000);
          throw new JupiterRateLimitedError(lastStatus === 429 ? 429 : 0, host, wait, attempt);
        }
        // Keyless refusal: switch host for the session (sticky), no wait, not counted as a retry.
        if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
          if (this.index < this.hosts.length - 1) { this.index++; continue; }
          throw err;
        }
        if (!isTransientJupiterError(err)) throw err;
        // Transient: the NEXT attempt goes to the other host (round robin; it stays there afterwards).
        if (this.hosts.length > 1) this.index = (this.index + 1) % this.hosts.length;
        const status = err instanceof HttpError ? err.status : 0;
        lastStatus = status;
        const retryAfter = err instanceof HttpError && err.retryAfterMs !== undefined ? err.retryAfterMs : 0;
        const backoff = Math.round(this.baseMs * 2 ** (attempt - 1) * (0.5 + this.random()));
        const wait = Math.max(retryAfter, backoff);
        const elapsed = this.clock.now() - started;
        if (attempt >= this.maxAttempts || elapsed + wait > this.maxTotalMs) {
          if (status === 429) throw new JupiterRateLimitedError(status, host, Math.max(wait, this.bucketPausedMs()), attempt);
          throw err;
        }
        await this.clock.sleep(wait, signal);
        if (signal?.aborted) throw abortError();
      }
    }
  }
}

function abortError(): Error {
  const e = new Error('aborted by caller');
  e.name = 'AbortError';
  return e;
}

export type SwapMode = 'ExactIn' | 'ExactOut';

interface JupSwapRawRoutePlan {
  swapInfo?: { label?: string; ammKey?: string };
  percent?: number;
}

export interface JupSwapRaw {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode?: string;
  slippageBps?: number;
  priceImpactPct?: string;
  platformFee?: { amount?: string; feeBps?: number } | null;
  routePlan?: JupSwapRawRoutePlan[];
  contextSlot?: number;
  swapUsdValue?: string;
  error?: string;
}

/** A normalized keyless swap quote. Amounts are raw base units carried as bigint (no float loss). */
export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  /** Raw input amount (base units of inputMint). */
  inAmount: bigint;
  /** Raw output amount (base units of outputMint) at the quoted route. */
  outAmount: bigint;
  /** Min out (ExactIn) / max in (ExactOut) after slippage, raw base units. */
  otherAmountThreshold: bigint;
  mode: SwapMode;
  slippageBps: number;
  /**
   * Price impact as a PERCENT (e.g. 94.67 means 94.67%); null when the API omitted it.
   * Jupiter reports this as a 0..1 FRACTION (0.9467 == 94.67%); we normalize to a percent ONCE here
   * (task-1310 DEFECT 1) so every downstream consumer — the 3% signer cap and the ticket display —
   * speaks the same unit. Storing the raw fraction silently defeated the price-impact cap.
   */
  priceImpactPct: number | null;
  /** AMM labels along the route, in order (e.g. ['Meteora', 'Whirlpool']). */
  route: string[];
  /** Jupiter platform fee in bps when the quote carried one (keyless default: none). */
  platformFeeBps: number | null;
  /** Platform fee in raw output base units, when present. */
  platformFeeAmount: bigint | null;
  /** USD value of the swap as Jupiter reported it; null when absent. */
  usdValue: number | null;
  contextSlot: number | null;
  source: 'jupiter-swap';
  fetchedAt: number;
}

export interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  /** Raw amount in base units of inputMint (ExactIn) / outputMint (ExactOut). */
  amount: bigint;
  slippageBps: number;
  mode?: SwapMode;
}

/**
 * Parse a raw base-unit amount. STRICT (task-1310 round 2): only a non-negative decimal integer string
 * is accepted. `"1.5e11"`, `"abc"`, `"-1"`, `""`, a number or a missing field THROW instead of mapping
 * to 0n — a zero amount silently voided the USD caps downstream.
 */
function toBig(s: unknown, field = 'amount'): bigint {
  if (typeof s !== 'string' || !/^[0-9]{1,30}$/.test(s)) {
    throw new Error(`malformed quote: ${field} is not an integer string (${JSON.stringify(s).slice(0, 40)})`);
  }
  return BigInt(s);
}

export function normalizeSwapQuote(raw: JupSwapRaw, fetchedAt: number): SwapQuote {
  return {
    inputMint: raw.inputMint,
    outputMint: raw.outputMint,
    inAmount: toBig(raw.inAmount, 'inAmount'),
    outAmount: toBig(raw.outAmount, 'outAmount'),
    otherAmountThreshold: toBig(raw.otherAmountThreshold, 'otherAmountThreshold'),
    mode: raw.swapMode === 'ExactOut' ? 'ExactOut' : 'ExactIn',
    slippageBps: numOrNull(raw.slippageBps) ?? 0,
    // DEFECT 1: Jupiter's priceImpactPct is a 0..1 fraction; convert to a percent exactly once.
    priceImpactPct: (() => { const f = numOrNull(raw.priceImpactPct); return f === null ? null : f * 100; })(),
    route: (raw.routePlan ?? []).map((r) => r.swapInfo?.label ?? '').filter((s) => s.length > 0),
    platformFeeBps: numOrNull(raw.platformFee?.feeBps),
    platformFeeAmount: raw.platformFee?.amount !== undefined ? toBig(raw.platformFee.amount, 'platformFee.amount') : null,
    usdValue: numOrNull(raw.swapUsdValue),
    contextSlot: numOrNull(raw.contextSlot),
    source: 'jupiter-swap',
    fetchedAt,
  };
}

export class JupiterSwap {
  private readonly http: HttpClient;
  private readonly hosts: JupiterHosts;

  constructor(http: HttpClient, hosts: readonly string[] = JUP_SWAP_HOSTS, retry: JupiterRetryOptions = {}) {
    this.http = http;
    this.hosts = new JupiterHosts(hosts, { clock: http.clock, bucketPausedMs: () => http.pausedFor(SWAP.bucket), sourceUnavailableMs: () => http.unavailableFor(SWAP.source), ...retry });
  }

  get host(): string {
    return this.hosts.host;
  }

  /**
   * A single keyless quote. Throws HttpError (redacted) on transport/HTTP/validation failure.
   * `signal` bounds the wait (task-1310): a confirm-time quote passes an 8 s abort so a 429 pause
   * on the shared keyless bucket can never hang the booking; the abort rejects with an AbortError.
   */
  async quote(req: QuoteRequest, signal?: AbortSignal): Promise<SwapQuote> {
    if (!(req.amount > 0n)) throw new Error('quote amount must be a positive integer of base units');
    if (req.inputMint === req.outputMint) throw new Error('quote needs two different mints');
    const params = new URLSearchParams({
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      amount: req.amount.toString(),
      slippageBps: String(Math.max(0, Math.round(req.slippageBps))),
      swapMode: req.mode ?? 'ExactIn',
    });
    const r = await this.get(`/swap/v1/quote?${params.toString()}`, signal);
    const d = r.data;
    if (!d || typeof d !== 'object' || d.inAmount === undefined || d.outAmount === undefined) {
      throw new HttpError(r.status, `${this.host}/swap/v1/quote`, 'empty or malformed quote');
    }
    return normalizeSwapQuote(d, r.fetchedAt);
  }

  /** task-1368: 401/403 → sticky failover; 429/5xx/transport → alternate host + bounded retry (JupiterHosts). */
  private get(path: string, signal?: AbortSignal): Promise<JsonResult<JupSwapRaw>> {
    return this.hosts.run((host) => this.http.getJson<JupSwapRaw>(`${host}${path}`, SWAP, (data) => {
      const e = (data as { error?: unknown } | null)?.error;
      return typeof e === 'string' && e.length > 0 ? { error: e } : null;
    }, signal), signal);
  }
}
