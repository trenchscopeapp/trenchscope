// Per-bucket rate limiter (SPEC §3.4): a token bucket for smoothness plus a
// hard sliding-window ceiling so a bucket can never grant more than its budget
// in any 60 s window, whatever the burst setting. Over-budget callers queue
// FIFO; nothing is dropped.

import type { Clock } from './clock.ts';
import { systemClock } from './clock.ts';
import type { SourceId } from './model.ts';

export interface BucketConfig {
  /** Documented requests-per-minute ceiling for this bucket. */
  rpm: number;
  /** Fraction of `rpm` we allow ourselves (SPEC default 0.7). */
  safety?: number;
  /** Token-bucket capacity (max back-to-back burst). Defaults to ~10% of budget. */
  burst?: number;
  /** Where the number comes from, for docs and the keys/doctor screen. */
  basis?: string;
  /**
   * Slots kept back for foreground work (task-1323). `low`/`idle` waiters are only granted while at
   * least `reserve` tokens AND `reserve` window slots would remain afterwards, so a user-visible request
   * ('high'/'normal') is never stuck behind background refreshes and prefetches. Never raises the
   * budget: the hard 60 s window ceiling and the refill rate are unchanged. Clamped to capacity - 1.
   */
  reserve?: number;
}

/**
 * Request priority (task-1323). Queue order is high > normal > low (FIFO within a class):
 *   high    the thing the user is waiting on right now (a cold chart); may use the reserve
 *   normal  the default for every caller that does not say (unchanged behaviour)
 *   low     background refreshes / prefetches; never consumes the reserve
 *   idle    opportunistic (hover prefetch): granted only when the bucket is completely idle and the
 *           reserve stays intact; NEVER queues — acquire() rejects at once with RateDeferredError.
 */
export type Priority = 'high' | 'normal' | 'low' | 'idle';
const RANK: Record<Priority, number> = { idle: 0, low: 1, normal: 2, high: 3 };

/**
 * A mutable priority shared between a request and whoever coalesced onto it: when a foreground caller
 * joins a background request already queued for the same thing, it raises the ref and the bucket
 * re-sorts its queue, so coalescing can never pin a user-visible fetch behind background priority.
 */
export class PriorityRef {
  level: Priority;
  private readonly listeners = new Set<() => void>();
  constructor(level: Priority = 'normal') { this.level = level; }
  /** Raise (never lower) the level; notifies listeners when it changed. */
  raise(level: Priority): void {
    if (RANK[level] <= RANK[this.level]) return;
    this.level = level;
    for (const fn of [...this.listeners]) fn();
  }
  on(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
}

/** acquire() at `idle` priority when the bucket is not idle: nothing was sent, try again later. */
export class RateDeferredError extends Error {
  readonly bucket: string;
  constructor(bucket: string) {
    super(`rate bucket ${bucket} busy: idle-priority request deferred`);
    this.name = 'RateDeferredError';
    this.bucket = bucket;
  }
}

export const DEFAULT_SAFETY = 0.7;
export const WINDOW_MS = 60_000;

/**
 * Documented keyless limits. Buckets, not sources: DexScreener has two
 * classes of endpoint with separate limits; Jupiter Tokens v2 and Price v3
 * share one keyless bucket.
 */
export const DEFAULT_BUCKETS: Record<string, BucketConfig> = {
  // tokens/v1, token-pairs/v1, latest/dex/search, latest/dex/pairs
  dexscreener: { rpm: 300, basis: 'docs.dexscreener.com/api/reference (OpenAPI), SPEC §3.1 S1' },
  // token-profiles, token-boosts, community-takeovers, metas
  'dexscreener-slow': { rpm: 60, basis: 'docs.dexscreener.com/api/reference, SPEC §3.1 S1' },
  // Tokens v2 + Price v3, keyless 0.5 rps (free key 1 rps). Enforced over a short window:
  // the 2026-10-05 recording saw x-ratelimit-remaining 4..0 then a 429 on the 6th request
  // in ~9 s, so no bursting (1 per ~2.9 s at the 0.7 safety factor = max 4 per 10 s).
  jupiter: { rpm: 30, burst: 1, basis: 'developers.jup.ag/docs/portal/rate-limits, SPEC §3.1 S2/S3; observed 5 per short window' },
  // Keyless public API; competitors file says 30/min, SPEC and GeckoTerminal docs say 10/min: take the lower.
  // task-1323: burst 2 + reserve 1 — the budget is unchanged (7 per 60 s window at 0.7, one refill per
  // ~8.6 s), but background traffic (trades tape, candle refreshes, prefetch) can never take the last
  // token, so the chart the user just asked for goes out at once instead of queueing ~17 s behind them.
  geckoterminal: { rpm: 10, burst: 2, reserve: 1, basis: 'docs/geckoterminal-api/api-page.md, SPEC §3.1 S4' },
  // Undocumented: conservative guesses, tighten when D-06/D-08 land
  rugcheck: { rpm: 10, basis: 'undocumented; conservative guess' },
  // Public mainnet RPC documents 100 req/10 s per IP and 40/10 s per method, but
  // getTokenLargestAccounts is throttled far harder in practice: stay slow, no bursts.
  'solana-rpc': { rpm: 30, burst: 1, basis: 'public RPC (docs: 100/10 s per IP, 40/10 s per method); conservative, no burst' },
  pumpfun: { rpm: 6, basis: 'undocumented frontend API; conservative guess' },
  // Helius Free: 10 req/s RPC (docs/helius/pricing.md). The credit meter (credits.ts) is the real ceiling.
  helius: { rpm: 600, burst: 5, basis: 'Helius Free plan 10 rps RPC (docs/helius/pricing.md); credits metered separately' },
  // Solana Tracker data API with a user key: the paid plans state no rps cap, Free is 3 rps; one request per
  // token, so a conservative 60 rpm (burst 3) keeps the screener's batch from spending credits in a spike.
  solanatracker: { rpm: 60, burst: 3, basis: 'docs.solanatracker.io plans (Free 3 rps, paid uncapped); conservative' },
  // Shrine socket.io with a user key: limits undocumented. One history read (plus one subscribe snapshot per
  // pool per minute) per open chart per refresh, so a conservative 60 rpm stays well clear of any cap.
  shrine: { rpm: 60, burst: 4, basis: 'undocumented keyed socket.io API; conservative' },
  // GoPlus keyless Beta: undocumented, inventory 2026-10-06 §5 suggests starting at 30 rpm
  goplus: { rpm: 30, burst: 2, basis: 'undocumented keyless tier; inventory §5 starting point' },
  // task-1330 (I-03): CoinGecko keyless demo tier is 10/min (30/min with a demo key); one call per 60 s cycle.
  coingecko: { rpm: 10, burst: 1, basis: 'CoinGecko public API keyless 10/min (INTEGRATIONS-DESIGN §4, measured 2026-10-09)' },
  // Publishers' RSS: polite polling, one fetch per feed per 10 min; the bucket only guards against a bug.
  'news-rss': { rpm: 10, burst: 4, basis: 'polite RSS polling (INTEGRATIONS-DESIGN §4: every 10 min, cached)' },
  // task-1357 (I-02): X v2 user-context reads. search/recent is 300 / 15 min PER USER (= 20 rpm), list tweets
  // 900 / 15 min; one conservative bucket, and the adapter also honours every x-rate-limit-* header per endpoint.
  'x-api': { rpm: 20, burst: 2, basis: 'docs.x.com rate limits: search/recent 300 per 15 min per user (INTEGRATIONS-DESIGN §4)' },
};

/** Which bucket each source draws from. */
export const SOURCE_BUCKET: Partial<Record<SourceId, string>> = {
  dexscreener: 'dexscreener',
  'jupiter-tokens': 'jupiter',
  'jupiter-price': 'jupiter',
  // Swap *quote* for paper trading (task-1310): same keyless Jupiter bucket as Tokens/Price.
  'jupiter-swap': 'jupiter',
  geckoterminal: 'geckoterminal',
  rugcheck: 'rugcheck',
  'solana-rpc': 'solana-rpc',
  pumpfun: 'pumpfun',
  helius: 'helius',
  goplus: 'goplus',
  solanatracker: 'solanatracker',
  shrine: 'shrine',
  coingecko: 'coingecko',
  'news-rss': 'news-rss',
  'x-api': 'x-api',
};

interface Waiter { resolve: () => void; reject: (err: Error) => void; signal?: AbortSignal; onAbort?: () => void; ref: PriorityRef; seq: number; offRaise?: () => void }

export interface BucketStats {
  bucket: string;
  rpmLimit: number;
  budget: number;
  rpmUsed: number;
  queued: number;
  pausedUntil: number;
}

export class TokenBucket {
  readonly name: string;
  readonly rpmLimit: number;
  readonly budget: number; // max grants in any WINDOW_MS window
  readonly capacity: number;
  /** Tokens / window slots background (low/idle) work must leave untouched (task-1323). */
  readonly reserve: number;
  private readonly refillPerMs: number;
  private tokens: number;
  private lastRefill: number;
  private grants: number[] = []; // grant timestamps within the window, ascending
  private queue: Waiter[] = [];
  private pumping = false;
  private pausedUntil = 0;
  private readonly clock: Clock;
  // Cancels the pump()'s pending clock.sleep on close() so a quit while a bucket is parked in a rate
  // wait does not keep the event loop alive for the whole delay (task-1319, QA M1). close() aborts it;
  // so does a higher-priority arrival (task-1323), which makes the pump re-evaluate at once instead of
  // sleeping out a background waiter's longer wait. A normal paced wait stays ref'd.
  private sleeper: AbortController | null = null;
  private closed = false;
  private seq = 0;
  onGrant?: (at: number) => void;

  constructor(name: string, cfg: BucketConfig, clock: Clock = systemClock) {
    this.name = name;
    this.clock = clock;
    this.rpmLimit = cfg.rpm;
    const safety = cfg.safety ?? DEFAULT_SAFETY;
    if (!(cfg.rpm > 0) || !(safety > 0 && safety <= 1)) throw new Error(`bad limiter config for ${name}`);
    this.budget = Math.max(1, Math.floor(cfg.rpm * safety));
    this.capacity = Math.max(1, Math.min(this.budget, cfg.burst ?? Math.ceil(this.budget / 10)));
    this.reserve = Math.max(0, Math.min(this.capacity - 1, Math.floor(cfg.reserve ?? 0)));
    this.refillPerMs = this.budget / WINDOW_MS;
    this.tokens = this.capacity;
    this.lastRefill = clock.now();
  }

  /** Grant immediately if allowed (and nobody is queued ahead); never waits. `level` applies the reserve rules. */
  tryAcquire(level: Priority = 'normal'): boolean {
    const now = this.clock.now();
    if (this.queue.length > 0 || this.delayFor(level, now) > 0) return false;
    this.grant(now);
    return true;
  }

  /** Stop granting and wake the pump's pending sleep; queued waiters are rejected (task-1319). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sleeper?.abort();
    const q = this.queue.splice(0);
    for (const w of q) {
      if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
      w.offRaise?.();
      w.reject(abortError());
    }
  }

  /**
   * Resolve when a request slot is granted. Queues behind earlier callers of the same or higher
   * priority (FIFO within a class). `priority` may be a level or a shared PriorityRef (raised later by
   * a coalescing foreground caller). `idle` never queues: it grants now or rejects with RateDeferredError.
   */
  acquire(signal?: AbortSignal, priority: Priority | PriorityRef = 'normal'): Promise<void> {
    if (this.closed) return Promise.reject(abortError());
    if (signal?.aborted) return Promise.reject(abortError());
    const ref = typeof priority === 'string' ? new PriorityRef(priority) : priority;
    if (ref.level === 'idle') {
      return this.tryAcquire('idle') ? Promise.resolve() : Promise.reject(new RateDeferredError(this.name));
    }
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = { resolve, reject, signal, ref, seq: this.seq++ };
      if (signal) {
        w.onAbort = () => {
          const i = this.queue.indexOf(w);
          if (i >= 0) this.queue.splice(i, 1);
          w.offRaise?.();
          reject(abortError());
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      // A raise while queued (a foreground caller coalesced onto this request) re-sorts the queue.
      w.offRaise = ref.on(() => this.nudge());
      this.queue.push(w);
      this.nudge();
    });
  }

  /** Re-evaluate the queue now: wakes a pump parked on a lower-priority wait, or starts one. */
  private nudge(): void {
    if (this.pumping) this.sleeper?.abort();
    else void this.pump();
  }

  /** Stop granting for `ms` (e.g. after a 429 / Retry-After). */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.clock.now() + Math.max(0, ms));
  }

  stats(): BucketStats {
    const now = this.clock.now();
    this.expire(now);
    return {
      bucket: this.name,
      rpmLimit: this.rpmLimit,
      budget: this.budget,
      rpmUsed: this.grants.length,
      queued: this.queue.length,
      pausedUntil: this.pausedUntil > now ? this.pausedUntil : 0,
    };
  }

  /**
   * Milliseconds until a grant at `level` would be allowed (0 = now). high/normal: the plain token +
   * window rule (`delay`). low: additionally keep `reserve` tokens and window slots. idle: the bucket
   * must be full (no recent grants at all) with the window reserve intact.
   */
  delayFor(level: Priority, now: number): number {
    let wait = this.delay(now);
    if (level === 'high' || level === 'normal' || this.reserve === 0 && level === 'low') return wait;
    const needTokens = level === 'idle' ? this.capacity : 1 + this.reserve;
    if (this.tokens < needTokens) wait = Math.max(wait, Math.ceil((needTokens - this.tokens) / this.refillPerMs));
    const maxInWindow = this.budget - this.reserve - (level === 'idle' ? 1 : 0);
    if (maxInWindow <= 0) return Number.POSITIVE_INFINITY;
    if (this.grants.length >= maxInWindow) {
      const oldestToExpire = this.grants[this.grants.length - maxInWindow];
      wait = Math.max(wait, oldestToExpire + WINDOW_MS - now);
    }
    return wait > 0 ? Math.ceil(wait) : 0;
  }

  /** Milliseconds until the next grant would be allowed (0 = now). */
  delay(now: number): number {
    this.refill(now);
    this.expire(now);
    let wait = 0;
    if (this.pausedUntil > now) wait = Math.max(wait, this.pausedUntil - now);
    if (this.tokens < 1) wait = Math.max(wait, (1 - this.tokens) / this.refillPerMs);
    if (this.grants.length >= this.budget) wait = Math.max(wait, this.grants[0] + WINDOW_MS - now);
    return wait > 0 ? Math.ceil(wait) : 0;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        if (this.closed) return;
        const now = this.clock.now();
        // Highest priority first, FIFO within a class (levels are read live: a ref may have been raised).
        let head = 0;
        for (let i = 1; i < this.queue.length; i++) {
          const a = this.queue[i], b = this.queue[head];
          if (RANK[a.ref.level] > RANK[b.ref.level] || (RANK[a.ref.level] === RANK[b.ref.level] && a.seq < b.seq)) head = i;
        }
        const w = this.queue[head];
        const wait = this.delayFor(w.ref.level, now);
        if (wait > 0) {
          // close() or a higher-priority arrival aborts this, so quit never waits it out and a
          // foreground request never sleeps out a background waiter's (longer) reserve wait.
          this.sleeper = new AbortController();
          await this.clock.sleep(Number.isFinite(wait) ? wait : WINDOW_MS, this.sleeper.signal);
          this.sleeper = null;
          if (this.closed) return;
          continue;
        }
        this.queue.splice(head, 1);
        if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
        w.offRaise?.();
        this.grant(now);
        w.resolve();
      }
    } finally {
      this.pumping = false;
    }
  }

  private grant(now: number): void {
    this.tokens -= 1;
    this.grants.push(now);
    this.onGrant?.(now);
  }

  private refill(now: number): void {
    if (now > this.lastRefill) {
      this.tokens = Math.min(this.capacity, this.tokens + (now - this.lastRefill) * this.refillPerMs);
      this.lastRefill = now;
    }
  }

  private expire(now: number): void {
    let i = 0;
    while (i < this.grants.length && this.grants[i] + WINDOW_MS <= now) i++;
    if (i > 0) this.grants.splice(0, i);
  }
}

export class RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly clock: Clock;

  constructor(configs: Record<string, BucketConfig> = DEFAULT_BUCKETS, clock: Clock = systemClock, safety?: number) {
    this.clock = clock;
    for (const [name, cfg] of Object.entries(configs)) {
      this.buckets.set(name, new TokenBucket(name, safety === undefined ? cfg : { ...cfg, safety: cfg.safety ?? safety }, clock));
    }
  }

  bucket(name: string): TokenBucket {
    const b = this.buckets.get(name);
    if (!b) throw new Error(`unknown rate-limit bucket: ${name}`);
    return b;
  }

  /** Create a bucket on demand (idempotent); used by the RPC pool to give each endpoint its own budget. */
  ensureBucket(name: string, cfg: BucketConfig): TokenBucket {
    let b = this.buckets.get(name);
    if (!b) {
      b = new TokenBucket(name, cfg, this.clock);
      this.buckets.set(name, b);
    }
    return b;
  }

  acquire(name: string, signal?: AbortSignal, priority?: Priority | PriorityRef): Promise<void> {
    return this.bucket(name).acquire(signal, priority);
  }

  pause(name: string, ms: number): void {
    this.bucket(name).pause(ms);
  }

  /** Close every bucket: wake pending rate-waits and reject queued acquires so a quit exits at once. */
  close(): void {
    for (const b of this.buckets.values()) b.close();
  }

  stats(): BucketStats[] {
    return [...this.buckets.values()].map((b) => b.stats());
  }
}

function abortError(): Error {
  const e = new Error('rate-limit wait aborted');
  e.name = 'AbortError';
  return e;
}
