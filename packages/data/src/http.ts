// Keyless, read-only HTTP client. Every call goes through the health gate and
// the rate limiter, is timed, and reports its outcome to the health registry.
// GET for REST sources; POST only for JSON-RPC reads (the Solana RPC adapter
// allow-lists read-only methods). The one auth header is a keyed source's `x-api-key` on a GET
// (Solana Tracker): it lives only on the request object, never in the URL, so recordings, logs
// and errors (which carry method + URL) never see it.
// The transport is pluggable: live fetch, recorder (live + capture) or replayer
// (fixtures only, never touches the network).

import type { Clock } from './clock.ts';
import { systemClock } from './clock.ts';
import type { HealthRegistry } from './health.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { PriorityRef, type Priority, type RateLimiter } from './limiter.ts';
import type { SourceId } from './model.ts';
import { redactSecrets } from './rpc-config.ts';

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  /** JSON request body (POST / JSON-RPC only). */
  body?: string;
  /**
   * `Accept` header override for non-JSON documents (task-1330: publishers' RSS/XML). Not part of the
   * fixture match key (method + URL), so recordings replay whatever the caller asks for.
   */
  accept?: string;
  /** Caller abort (e.g. a bounded confirm-time quote, task-1310). Combined with the transport timeout. */
  signal?: AbortSignal;
  /** A keyed source's API key, sent as `x-api-key`. Not part of the fixture key; never logged. */
  apiKey?: string;
  /** The only host `apiKey` may be sent to. Required with apiKey: a keyed request elsewhere is refused. */
  apiKeyHost?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Wall-clock latency as measured by the transport (recorded for replays). */
  latencyMs: number;
}

export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

/** Response headers worth keeping (rate-limit hints); everything else is dropped. */
const KEEP_HEADERS = ['content-type', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];

export interface LiveTransportOptions {
  timeoutMs?: number;
  userAgent?: string;
  /**
   * Aborted on shutdown (task-1319): without it a quit while a request is in flight waits out the
   * per-request timeout (default 10 s), so the process lingers 10-33 s after `q`. Abort it on close()
   * and the in-flight fetch rejects at once, releasing the event loop so exit is well under 1 s.
   */
  shutdownSignal?: AbortSignal;
}

/** Real network via global fetch. No cookies; the only auth header is a keyed GET's `x-api-key`. */
export function liveTransport(opts: LiveTransportOptions = {}): Transport {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const userAgent = opts.userAgent ?? 'dexterm/0.0.1 (+local terminal screener; keyless read-only)';
  const shutdownSignal = opts.shutdownSignal;
  return async (req) => {
    const t0 = performance.now();
    const headers: Record<string, string> = { accept: req.accept ?? 'application/json', 'user-agent': userAgent };
    if (req.body !== undefined) headers['content-type'] = 'application/json';
    // A keyed request goes only to its own host over https, and never follows a redirect: Node's fetch keeps
    // custom headers across a cross-origin redirect (it strips only Authorization/Cookie), so a 3xx would
    // otherwise hand the key to whatever host it names.
    const keyed = req.apiKey !== undefined;
    if (keyed) {
      const u = new URL(req.url);
      if (req.method !== 'GET' || u.protocol !== 'https:' || !req.apiKeyHost || u.host !== req.apiKeyHost) {
        throw new Error(`keyed request refused: only GET https://${req.apiKeyHost ?? '?'} may carry the key`);
      }
      headers['x-api-key'] = req.apiKey!;
    }
    // Own the timeout + shutdown abort via one controller instead of AbortSignal.timeout(): the latter
    // schedules an internal *ref'd* timer that is never cancelled when the fetch settles (or when a
    // companion signal fires), so each live request left a ref'd ~10 s timer keeping the event loop
    // alive — the 10-33 s quit hang (task-1319, QA M1). This timer is unref'd (never holds the loop on
    // its own) and cleared the instant the request settles, and the shutdown signal aborts it at once.
    // The caller may also pass its own abort (task-1310: bounded confirm quote); whichever fires first wins.
    const controller = new AbortController();
    const onTimeout = () => controller.abort(new DOMException(`timed out after ${timeoutMs}ms`, 'TimeoutError'));
    const onShutdown = () => controller.abort(new DOMException('shutting down', 'AbortError'));
    const onCaller = () => controller.abort(req.signal?.reason ?? new DOMException('aborted by caller', 'AbortError'));
    const timer = setTimeout(onTimeout, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    if (shutdownSignal) {
      if (shutdownSignal.aborted) onShutdown();
      else shutdownSignal.addEventListener('abort', onShutdown, { once: true });
    }
    if (req.signal) {
      if (req.signal.aborted) onCaller();
      else req.signal.addEventListener('abort', onCaller, { once: true });
    }
    try {
      const res = await globalThis.fetch(req.url, {
        method: req.method,
        headers,
        body: req.body,
        signal: controller.signal,
        redirect: keyed ? 'error' : 'follow',
      });
      const body = await res.text();
      const kept: Record<string, string> = {};
      for (const h of KEEP_HEADERS) {
        const v = res.headers.get(h);
        if (v !== null) kept[h] = v;
      }
      return { status: res.status, headers: kept, body, latencyMs: Math.round(performance.now() - t0) };
    } finally {
      clearTimeout(timer);
      shutdownSignal?.removeEventListener('abort', onShutdown);
      req.signal?.removeEventListener('abort', onCaller);
    }
  };
}

/**
 * Parse a `Retry-After` header (seconds) to ms; undefined when absent or not a positive number. task-1368:
 * Jupiter's keyless gateway sends NO Retry-After on a 429 (recorded 2026-10-12, fixtures/trade/jupiter-429-*.json)
 * but does send `x-ratelimit-reset` (epoch seconds), so when Retry-After is absent the wait is derived from the
 * reset time instead — the honest number for "retry in Ns" and for the retry policy.
 */
function retryAfterMs(res: HttpResponse, now?: number): number | undefined {
  const v = Number(res.headers['retry-after']);
  if (Number.isFinite(v) && v > 0) return v * 1000;
  if (now !== undefined) {
    const reset = Number(res.headers['x-ratelimit-reset']);
    if (Number.isFinite(reset) && reset > 0) {
      const until = reset * 1000 - now;
      if (until > 0) return Math.min(until, MAX_HEADER_PAUSE_MS);
    }
  }
  return undefined;
}

const MAX_HEADER_PAUSE_MS = 60_000;
/** Cap for the doubling pause after consecutive 429s on one bucket (matches the health backoff cap). */
const MAX_429_PAUSE_MS = 600_000;

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  /** Retry-After in ms when the server sent one (429/503); used by the RPC pool to pause an endpoint. */
  readonly retryAfterMs?: number;
  constructor(status: number, url: string, message?: string, retryAfterMs?: number) {
    // URLs may carry an RPC api-key: never let one into a message that can reach a log or the screen.
    super(redactSecrets(message ?? `HTTP ${status} for ${url}`));
    this.name = 'HttpError';
    this.status = status;
    this.url = redactSecrets(url);
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export class SourceUnavailableError extends Error {
  readonly source: SourceId;
  constructor(source: SourceId, state: string) {
    super(`source ${source} is ${state}`);
    this.name = 'SourceUnavailableError';
    this.source = source;
  }
}

export interface RequestMeta {
  source: SourceId;
  /** Rate-limit bucket (see DEFAULT_BUCKETS). */
  bucket: string;
}

/**
 * Inspect a parsed 2xx body before it counts as a success. Return a failure to
 * treat it as one (e.g. a JSON-RPC `error` object, or a rate-limit error
 * delivered with HTTP 200); `status: 429` makes it count as a 429.
 */
export type BodyCheck = (data: unknown) => { status?: number; error: string } | null;

export interface JsonResult<T> {
  data: T;
  status: number;
  latencyMs: number;
  fetchedAt: number;
}

export interface HttpClientOptions {
  transport: Transport;
  limiter: RateLimiter;
  health: HealthRegistry;
  clock?: Clock;
  /** Pause after a 429 without Retry-After; doubles per consecutive 429 on the same bucket (cap 10 min). */
  rateLimitPauseMs?: number;
  /** Called after every attempted request (for request budgets / logging). */
  onRequest?: (req: HttpRequest, meta: RequestMeta, outcome: { status: number | null; latencyMs: number }) => void;
}

/**
 * Request priority context (task-1323). Code that knows how urgent its requests are wraps the call:
 * `withPriority('high', () => dl.detail.candles(...))`; every request issued inside (through any number
 * of awaits, caches and adapters) is queued at that priority in its rate bucket. Without a context a
 * request is 'normal' — the pre-1323 behaviour. Passing a PriorityRef shares it, so a later raise()
 * (a foreground caller coalescing onto a background load) re-prioritises requests already queued.
 */
const priorityContext = new AsyncLocalStorage<PriorityRef>();

export function withPriority<T>(priority: Priority | PriorityRef, fn: () => T): T {
  return priorityContext.run(typeof priority === 'string' ? new PriorityRef(priority) : priority, fn);
}

/** The caller's priority context, if any (undefined = normal). */
export function currentPriority(): PriorityRef | undefined {
  return priorityContext.getStore();
}

export class HttpClient {
  private readonly opts: HttpClientOptions;
  /** The clock every wait in this client runs on (a FakeClock in tests); adapters pace their own retries by it. */
  readonly clock: Clock;
  private readonly inflight = new Map<string, { p: Promise<JsonResult<unknown>>; ref: PriorityRef }>();
  /** Consecutive 429s per bucket, for the doubling pause. Reset by any non-429 response. */
  private readonly strikes = new Map<string, number>();

  constructor(opts: HttpClientOptions) {
    this.opts = opts;
    this.clock = opts.clock ?? systemClock;
  }

  /** GET JSON. Identical in-flight URLs share one request (SPEC §3.4 coalescing). */
  getJson<T>(url: string, meta: RequestMeta, check?: BodyCheck, signal?: AbortSignal): Promise<JsonResult<T>> {
    return this.coalesce<T>(`GET ${url}`, { method: 'GET', url, signal }, meta, check);
  }

  /**
   * GET JSON from a keyed source with its key in the `x-api-key` header (never the URL). Coalesced on the URL
   * like getJson: every caller of a keyed adapter shares the one key, so sharing an in-flight request is safe.
   */
  getJsonKeyed<T>(url: string, auth: { key: string; host: string }, meta: RequestMeta, check?: BodyCheck, signal?: AbortSignal): Promise<JsonResult<T>> {
    // the coalescing key carries a short key fingerprint, so a keyless or other-key call can never share it
    const fp = createHash('sha256').update(auth.key).digest('hex').slice(0, 8);
    return this.coalesce<T>(`GET ${url} k:${fp}`, { method: 'GET', url, signal, apiKey: auth.key, apiKeyHost: auth.host }, meta, check);
  }

  /**
   * POST a JSON body (JSON-RPC reads only). Identical in-flight url+body pairs share one request.
   * `signal` (task-1368) bounds the wait like getJson's: a caller deadline cuts the limiter queue and the
   * transport, and an abortable POST is never shared.
   */
  postJson<T>(url: string, body: unknown, meta: RequestMeta, check?: BodyCheck, signal?: AbortSignal): Promise<JsonResult<T>> {
    const text = JSON.stringify(body);
    return this.coalesce<T>(`POST ${url} ${text}`, { method: 'POST', url, body: text, signal }, meta, check);
  }

  /** Ms until a DEGRADED source is probed again (0 when it is available or unknown). The health gate's own cool-down. */
  unavailableFor(source: SourceId): number {
    try {
      const h = this.opts.health.get(source);
      return h.state === 'degraded' ? Math.max(0, h.degradedUntil - this.clock.now()) : 0;
    } catch {
      return 0;
    }
  }

  /** Remaining pause on a rate bucket in ms (0 when it is not paused or unknown). For honest "retry in Ns" messages. */
  pausedFor(bucket: string): number {
    try {
      const until = this.opts.limiter.bucket(bucket).stats().pausedUntil;
      return until > 0 ? Math.max(0, until - this.clock.now()) : 0;
    } catch {
      return 0;
    }
  }

  /**
   * GET a text document (task-1330: RSS/XML news feeds). Same gate, limiter, health accounting,
   * coalescing and rate-limit header handling as getJson; the body is returned unparsed.
   */
  getText(url: string, meta: RequestMeta, accept = 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5'): Promise<JsonResult<string>> {
    return this.coalesce<string>(`GET ${url}`, { method: 'GET', url, accept }, meta, undefined, true);
  }

  private coalesce<T>(key: string, req: HttpRequest, meta: RequestMeta, check?: BodyCheck, raw = false): Promise<JsonResult<T>> {
    const caller = currentPriority();
    // An abortable request is never shared (task-1310): a caller that cancels (e.g. a bounded confirm
    // quote) must not cancel an unrelated caller, and must not be ignored by joining a non-abortable one.
    if (req.signal) return this.doRequest<T>(req, meta, check, new PriorityRef(caller?.level ?? 'normal'));
    const existing = this.inflight.get(key);
    if (existing) {
      // A more urgent caller joining a queued request lifts it (task-1323): never inherit a lower priority.
      if (caller) existing.ref.raise(caller.level);
      return existing.p as Promise<JsonResult<T>>;
    }
    // Each request gets its own ref seeded from the caller's level and following the caller's raises,
    // so raising one coalesced request does not re-prioritise unrelated requests of the same caller.
    const ref = new PriorityRef(caller?.level ?? 'normal');
    const off = caller ? caller.on(() => ref.raise(caller.level)) : null;
    const p = this.doRequest<T>(req, meta, check, ref, raw).finally(() => { this.inflight.delete(key); off?.(); });
    this.inflight.set(key, { p: p as Promise<JsonResult<unknown>>, ref });
    return p;
  }

  /**
   * 429 -> pause (Retry-After, or the default doubling per consecutive 429 on the bucket);
   * `x-ratelimit-remaining: 0` -> pause until reset (capped).
   */
  private respectRateLimitHeaders(res: HttpResponse, meta: RequestMeta, rateLimited = res.status === 429): void {
    const { limiter } = this.opts;
    if (rateLimited) {
      const n = (this.strikes.get(meta.bucket) ?? 0) + 1;
      this.strikes.set(meta.bucket, n);
      const base = this.opts.rateLimitPauseMs ?? 30_000;
      const backoff = Math.min(base * 2 ** (n - 1), MAX_429_PAUSE_MS);
      // The server's own wait (Retry-After, else its x-ratelimit-reset — task-1368) governs the first strike;
      // a repeated 429 on the same bucket never pauses less than the doubling backoff.
      const stated = retryAfterMs(res, this.clock.now());
      limiter.pause(meta.bucket, stated !== undefined ? Math.max(stated, n > 1 ? backoff : 0) : backoff);
    } else {
      this.strikes.delete(meta.bucket);
    }
    if (res.headers['x-ratelimit-remaining'] === '0') {
      const reset = Number(res.headers['x-ratelimit-reset']); // epoch seconds (Jupiter)
      const until = Number.isFinite(reset) && reset > 0 ? reset * 1000 - this.clock.now() : 10_000;
      limiter.pause(meta.bucket, Math.min(Math.max(until, 1_000), MAX_HEADER_PAUSE_MS));
    }
  }

  private async doRequest<T>(req: HttpRequest, meta: RequestMeta, check?: BodyCheck, priority?: PriorityRef, raw = false): Promise<JsonResult<T>> {
    const { health, limiter, transport } = this.opts;
    const url = req.url;
    if (!health.isAvailable(meta.source)) throw new SourceUnavailableError(meta.source, health.state(meta.source));
    // Pass the caller's abort to the limiter so a bounded wait is cut even while queued behind a
    // 429 pause (task-1310): the confirm-time quote can never hang past its deadline in the bucket.
    await limiter.acquire(meta.bucket, req.signal, priority);
    let res: HttpResponse;
    try {
      res = await transport(req);
    } catch (err) {
      const msg = redactSecrets(err instanceof Error ? err.message : String(err));
      health.record(meta.source, { ok: false, error: msg });
      this.opts.onRequest?.(req, meta, { status: null, latencyMs: 0 });
      throw err;
    }
    this.opts.onRequest?.(req, meta, { status: res.status, latencyMs: res.latencyMs });
    if (res.status < 200 || res.status >= 300) {
      this.respectRateLimitHeaders(res, meta);
      health.record(meta.source, { ok: false, status: res.status, latencyMs: res.latencyMs });
      throw new HttpError(res.status, url, undefined, retryAfterMs(res, this.clock.now()));
    }
    if (raw) {
      // Text document (RSS/XML): no JSON parse, no body check; headers still drive the limiter.
      this.respectRateLimitHeaders(res, meta);
      health.record(meta.source, { ok: true, status: res.status, latencyMs: res.latencyMs });
      return { data: res.body as unknown as T, status: res.status, latencyMs: res.latencyMs, fetchedAt: this.clock.now() };
    }
    let data: T;
    try {
      data = JSON.parse(res.body) as T;
    } catch {
      this.respectRateLimitHeaders(res, meta);
      health.record(meta.source, { ok: false, status: res.status, latencyMs: res.latencyMs, error: 'invalid JSON' });
      throw new HttpError(res.status, url, `invalid JSON from ${url}`);
    }
    const bad = check?.(data);
    this.respectRateLimitHeaders(res, meta, bad?.status === 429);
    if (bad) {
      const status = bad.status ?? res.status;
      health.record(meta.source, { ok: false, status, latencyMs: res.latencyMs, error: bad.error });
      throw new HttpError(status, url, `${bad.error} (${url})`, retryAfterMs(res, this.clock.now()));
    }
    health.record(meta.source, { ok: true, status: res.status, latencyMs: res.latencyMs });
    return { data, status: res.status, latencyMs: res.latencyMs, fetchedAt: this.clock.now() };
  }
}
