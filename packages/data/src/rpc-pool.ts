// RPC pool with rotation, per-endpoint health scoring and 429/Retry-After backoff (task-1309).
//
// Why a pool: a single public RPC is throttled hard (getTokenLargestAccounts 429s per IP), and a
// user may supply several free endpoints (Helius / Alchemy / QuickNode / Ankr free tiers, each with
// its own quota tied to their own key and IP). The pool spreads reads across every endpoint it has,
// prefers the healthiest, and when one 429s it is paused (honouring Retry-After) while the others keep
// serving. Each endpoint has its own rate-limit bucket so one endpoint's pause never stalls the rest.
//
// FREE-FOREVER: the pool works with zero endpoints configured beyond the keyless public RPC. Adding a
// free key only adds endpoints (more quota, and the methods the public RPC blocks, e.g. the ranked
// holder list); it never gates a feature. Endpoint URLs may carry a key: never log one — redactSecrets().

import type { Clock } from './clock.ts';
import { systemClock } from './clock.ts';
import { HttpError } from './http.ts';
import type { HttpClient } from './http.ts';
import type { RateLimiter } from './limiter.ts';
import { SolanaRpc, type MintInfo, type RpcSource, type TopHolders } from './sources/solana-rpc.ts';
import { redactSecrets } from './rpc-config.ts';

export interface RpcEndpointSpec {
  url: string;
  source: RpcSource;
  /** Rate-limit bucket name; defaults to a per-host bucket so endpoints do not share a pause. */
  bucket?: string;
  /** Documented requests-per-minute for this endpoint's bucket. */
  rpm?: number;
  burst?: number;
  /** Safe-to-print label (host + plan), shown in the budget/doctor view. Never the URL. */
  label: string;
  /** Where the number/endpoint came from (docs, env var), for the doctor screen. */
  basis?: string;
  /** Whether this endpoint carries a user key (keyed endpoints are tried first: higher quota). */
  keyed?: boolean;
}

/** Default bucket config for a pool endpoint when the spec does not give one. */
const DEFAULT_RPM = 30;
const DEFAULT_BURST = 1;
/** Pool-level pause after a 429 with no Retry-After; doubles per consecutive 429, capped. */
const BASE_429_PAUSE_MS = 2_000;
const MAX_429_PAUSE_MS = 120_000;
/** Pool-level cooldown after a non-429 failure (network/5xx), so rotation moves on without hammering. */
const ERROR_COOLDOWN_MS = 3_000;
const MAX_ERROR_COOLDOWN_MS = 30_000;

interface Endpoint {
  spec: RpcEndpointSpec;
  rpc: SolanaRpc;
  /** Declaration order (keyed/preferred endpoints first); used as a stable tie-break. */
  priority: number;
  consecutiveFailures: number;
  okCount: number;
  errorCount: number;
  lastLatencyMs: number | null;
  /** Pool clock ms until which this endpoint is skipped (0 = available now). */
  pausedUntil: number;
  lastError: string | null;
}

export interface RpcEndpointStatus {
  label: string;
  source: RpcSource;
  keyed: boolean;
  okCount: number;
  errorCount: number;
  consecutiveFailures: number;
  lastLatencyMs: number | null;
  /** 0 when available now, else pool-clock ms when it becomes usable again. */
  pausedUntil: number;
  available: boolean;
  lastError: string | null;
}

/** Thrown when every endpoint in the pool is paused or exhausted and none could serve the call. */
export class RpcPoolExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcPoolExhaustedError';
  }
}

export class RpcPool {
  private readonly endpoints: Endpoint[];
  private readonly clock: Clock;

  constructor(http: HttpClient, limiter: RateLimiter, specs: RpcEndpointSpec[], opts: { clock?: Clock } = {}) {
    this.clock = opts.clock ?? systemClock;
    if (specs.length === 0) throw new Error('RpcPool needs at least one endpoint');
    this.endpoints = specs.map((spec, i) => {
      const bucket = spec.bucket ?? bucketFor(spec.url);
      limiter.ensureBucket(bucket, { rpm: spec.rpm ?? DEFAULT_RPM, burst: spec.burst ?? DEFAULT_BURST, basis: spec.basis });
      return {
        spec,
        rpc: new SolanaRpc(http, { url: spec.url, source: spec.source, bucket }),
        priority: i,
        consecutiveFailures: 0,
        okCount: 0,
        errorCount: 0,
        lastLatencyMs: null,
        pausedUntil: 0,
        lastError: null,
      };
    });
  }

  get size(): number {
    return this.endpoints.length;
  }

  /** True when at least one endpoint carries a user key (unlocks the ranked holder list etc.). */
  get hasKeyed(): boolean {
    return this.endpoints.some((e) => e.spec.keyed);
  }

  /** The first endpoint's adapter — the "primary" for callers that still expect a single SolanaRpc. */
  get primary(): SolanaRpc {
    return this.endpoints[0].rpc;
  }

  /**
   * Run `fn` against endpoints in health order, failing over on error. A 429 pauses that endpoint
   * (Retry-After when the server sent one, else a doubling backoff) and moves to the next. The last
   * error propagates when every currently-available endpoint has failed.
   */
  async run<T>(fn: (rpc: SolanaRpc) => Promise<T>, label = 'rpc'): Promise<T> {
    const now = this.clock.now();
    const order = this.order(now);
    const available = order.filter((e) => e.pausedUntil <= now);
    const tryList = available.length > 0 ? available : order.slice(0, 1); // all paused: still try the soonest
    let lastError: unknown = new RpcPoolExhaustedError(`${label}: no RPC endpoint available`);
    for (const e of tryList) {
      const t0 = this.clock.now();
      try {
        const value = await fn(e.rpc);
        e.okCount++;
        e.consecutiveFailures = 0;
        e.pausedUntil = 0;
        e.lastError = null;
        e.lastLatencyMs = this.clock.now() - t0;
        return value;
      } catch (err) {
        lastError = err;
        this.penalize(e, err);
      }
    }
    throw lastError;
  }

  mintInfo(mint: string): Promise<MintInfo> {
    return this.run((rpc) => rpc.mintInfo(mint), 'mintInfo');
  }

  topHolders(mint: string, opts: { info?: MintInfo; resolveOwners?: boolean } = {}): Promise<TopHolders> {
    return this.run((rpc) => rpc.topHolders(mint, opts), 'topHolders');
  }

  /** Raw base64 account data through the pool (rotation + failover). Fast-lane price seeding. */
  accountsRaw(accounts: string[], commitment: 'processed' | 'confirmed' | 'finalized' = 'processed'): Promise<{ data: Map<string, string | null>; fetchedAt: number }> {
    return this.run((rpc) => rpc.accountsRaw(accounts, commitment), 'accountsRaw');
  }

  /** Owner + base64 data in one snapshot through the pool (Shrine chart PumpSwap verification). Read-only. */
  accountsInfo(accounts: string[], commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed'): Promise<Map<string, { owner: string; data: string } | null>> {
    return this.run((rpc) => rpc.accountsInfo(accounts, commitment), 'accountsInfo');
  }

  /** Account meta (owner program / existence) through the pool (task-1340 wallet intel). */
  accountMeta(accounts: string[], commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed'): Promise<Map<string, { programOwner: string | null; exists: boolean; lamports: number; executable?: boolean }>> {
    return this.run((rpc) => rpc.accountMeta(accounts, commitment), 'accountMeta');
  }

  /** The first endpoint whose source is `helius` (the keyed history endpoint), or null. Its URL carries the key: never print it. */
  get heliusUrl(): string | null {
    return this.endpoints.find((e) => e.spec.source === 'helius')?.spec.url ?? null;
  }

  status(): RpcEndpointStatus[] {
    const now = this.clock.now();
    return this.endpoints.map((e) => ({
      label: e.spec.label,
      source: e.spec.source,
      keyed: !!e.spec.keyed,
      okCount: e.okCount,
      errorCount: e.errorCount,
      consecutiveFailures: e.consecutiveFailures,
      lastLatencyMs: e.lastLatencyMs,
      pausedUntil: e.pausedUntil > now ? e.pausedUntil : 0,
      available: e.pausedUntil <= now,
      lastError: e.lastError,
    }));
  }

  /** Available endpoints first, then fewest consecutive failures, then declared priority, then latency. */
  private order(now: number): Endpoint[] {
    return [...this.endpoints].sort((a, b) => {
      const aAvail = a.pausedUntil <= now ? 0 : 1;
      const bAvail = b.pausedUntil <= now ? 0 : 1;
      if (aAvail !== bAvail) return aAvail - bAvail;
      if (a.consecutiveFailures !== b.consecutiveFailures) return a.consecutiveFailures - b.consecutiveFailures;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return (a.lastLatencyMs ?? 0) - (b.lastLatencyMs ?? 0);
    });
  }

  private penalize(e: Endpoint, err: unknown): void {
    e.errorCount++;
    e.consecutiveFailures++;
    e.lastError = redactSecrets(err instanceof Error ? err.message : String(err));
    const now = this.clock.now();
    const rateLimited = err instanceof HttpError && (err.status === 429 || err.status === 503);
    if (rateLimited) {
      const backoff = Math.min(BASE_429_PAUSE_MS * 2 ** (e.consecutiveFailures - 1), MAX_429_PAUSE_MS);
      const retry = err instanceof HttpError ? err.retryAfterMs : undefined;
      e.pausedUntil = now + Math.max(backoff, retry ?? 0);
    } else {
      e.pausedUntil = now + Math.min(ERROR_COOLDOWN_MS * e.consecutiveFailures, MAX_ERROR_COOLDOWN_MS);
    }
  }
}

/** Per-host bucket name for an endpoint, derived from the hostname (never the key). */
export function bucketFor(url: string): string {
  try {
    return `rpc:${new URL(url).hostname}`;
  } catch {
    return 'rpc:unknown';
  }
}
