// @dexterm/data — ImageService (task-1326): the one object the UI asks for coin images. `get(url)` is
// SYNCHRONOUS and never blocks: it answers from memory and, for an unknown URL, enqueues the work and
// answers `pending`. A small worker pool then (1) checks the on-disk cache, (2) fetches through the SSRF-
// safe binary fetch, (3) decodes + thumbnails in a worker thread, (4) stores our re-encoded PNG, and
// (5) calls `onChange` so the UI loop redraws. Priorities: the screen re-requests what is visible every
// frame, so the queue is served highest-priority-then-most-recent (the rows you are looking at win over
// a pool scrolled past). Offline / replay runs answer from disk only and never touch the network.
import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import type { RgbaImage } from './types.ts';
import { decodePng } from './png.ts';
import { fetchBytes, thumbnailUrl, type FetchBytesResult } from './fetch.ts';
import { ImageDiskCache, imageCacheKey } from './cache.ts';
import { runDecodeJob, type DecodeJob, type DecodeReply } from './decode-worker.ts';

export type ImageState =
  | { state: 'ready'; img: RgbaImage; png: Uint8Array; key: string }
  | { state: 'pending'; key: string }
  /** `retryAt`: a transient failure (429 / timeout / 5xx) is re-queued when asked for after this time. */
  | { state: 'missing'; reason: string; key: string; retryAt?: number }
  | { state: 'none' };

export interface ImageRequestLog { url: string; ok: boolean; bytes: number; ms: number; reason: string | null; source: 'disk' | 'network' | 'offline' }

export interface ImageServiceOptions {
  /** Cache directory (the app data dir + /images). */
  dir: string;
  /** Cache only: never fetch (replay, DEXTERM_OFFLINE). */
  offline?: boolean;
  /** Parallel fetches (default 3) and per-host cap (default 2). */
  concurrency?: number;
  perHost?: number;
  /** Longest thumbnail side stored and served (default 96 px). */
  thumbMax?: number;
  /** Decoded images kept in memory (default 400). */
  maxMemory?: number;
  /** Disk cache byte cap. */
  maxDiskBytes?: number;
  fetch?: (url: string, signal: AbortSignal) => Promise<FetchBytesResult>;
  /** Decoder seam (tests); default = a worker thread with a main-thread fallback. */
  decode?: (bytes: Uint8Array, thumbMax: number) => Promise<DecodeReply>;
  onChange?: () => void;
  /** Every network/disk outcome (the --verbose request log). */
  onRequest?: (r: ImageRequestLog) => void;
  now?: () => number;
  /** Rewrites a source URL to a small rendition when the host supports it (default thumbnailUrl). */
  rewrite?: (url: string) => string;
}

interface Entry { state: ImageState; url: string; key: string; priority: number; seq: number; at: number; attempts: number }

/** Backoff before a transient failure is retried: 2 min, then 10 min, then never (this session). */
export const RETRY_BACKOFF_MS = [120_000, 600_000] as const;

export interface ImageServiceStats {
  known: number; ready: number; missing: number; pending: number; inflight: number; queued: number;
  fetched: number; fetchFailed: number; diskHits: number; decodeFailed: number; decodeMsTotal: number; decodes: number; workerFallbacks: number;
  bytesFetched: number;
}

export class ImageService {
  private readonly mem = new Map<string, Entry>();
  private readonly queue: Entry[] = [];
  private readonly inflightUrls = new Set<string>();
  private readonly perHostInflight = new Map<string, number>();
  private readonly disk: ImageDiskCache;
  private readonly opts: Required<Pick<ImageServiceOptions, 'offline' | 'concurrency' | 'perHost' | 'thumbMax' | 'maxMemory'>> & ImageServiceOptions;
  private seq = 0;
  private closed = false;
  private worker: Worker | null = null;
  private workerBroken = false;
  private jobId = 0;
  private readonly jobs = new Map<number, { resolve: (r: DecodeReply) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly abort = new AbortController();
  /** Called after any image settles (ready or missing); the UI loop redraws. Settable after construction. */
  onChange: (() => void) | null = null;
  private idleWaiters: Array<() => void> = [];
  readonly stats: ImageServiceStats = { known: 0, ready: 0, missing: 0, pending: 0, inflight: 0, queued: 0, fetched: 0, fetchFailed: 0, diskHits: 0, decodeFailed: 0, decodeMsTotal: 0, decodes: 0, workerFallbacks: 0, bytesFetched: 0 };

  constructor(opts: ImageServiceOptions) {
    this.opts = { offline: false, concurrency: 3, perHost: 2, thumbMax: 96, maxMemory: 400, ...opts };
    this.disk = new ImageDiskCache({ dir: opts.dir, maxBytes: opts.maxDiskBytes, now: opts.now });
    this.onChange = opts.onChange ?? null;
  }

  /** True when nothing is queued or in flight. */
  get idle(): boolean { return this.queue.length === 0 && this.inflightUrls.size === 0; }

  /** Resolves once the queue drains (every requested image settled) or after `timeoutMs`. One-shot renders use it. */
  whenIdle(timeoutMs = 4000): Promise<boolean> {
    if (this.idle) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { this.idleWaiters = this.idleWaiters.filter((w) => w !== done); resolve(false); }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      const done = () => { clearTimeout(timer); resolve(true); };
      this.idleWaiters.push(done);
    });
  }

  get dir(): string { return this.disk.dir; }
  get offline(): boolean { return this.opts.offline; }

  /** Stable cache key for a source URL (the popup route and the disk file name use it). */
  keyFor(url: string): string { return imageCacheKey(url); }

  /**
   * The image for a URL, right now. Never blocks: unknown URLs are queued (bumping their priority /
   * recency on every ask) and answered `pending` until the worker lands them.
   */
  get(url: string | null | undefined, priority = 0): ImageState {
    if (!url || typeof url !== 'string') return { state: 'none' };
    const e = this.mem.get(url);
    if (e) {
      if (e.state.state === 'pending' && !this.inflightUrls.has(url)) { e.priority = Math.max(e.priority, priority); e.seq = ++this.seq; }
      else if (e.state.state === 'ready') { this.mem.delete(url); this.mem.set(url, e); } // LRU refresh
      else if (e.state.state === 'missing' && e.state.retryAt !== undefined && this.now() >= e.state.retryAt && !this.inflightUrls.has(url)) {
        // a transient failure, past its backoff: ask again (bounded by RETRY_BACKOFF_MS.length attempts)
        e.state = { state: 'pending', key: e.key }; e.priority = priority; e.seq = ++this.seq;
        this.queue.push(e); this.pump();
      }
      return e.state;
    }
    const key = this.keyFor(url);
    const entry: Entry = { state: { state: 'pending', key }, url, key, priority, seq: ++this.seq, at: this.now(), attempts: 0 };
    this.mem.set(url, entry);
    this.queue.push(entry);
    this.stats.known = this.mem.size;
    this.pump();
    return entry.state;
  }

  /** Warm a set of URLs (visible rows, the open token) at a priority; no answer needed. */
  prefetch(urls: ReadonlyArray<string | null | undefined>, priority = 0): void {
    for (const u of urls) if (u) this.get(u, priority);
  }

  /** Our stored PNG for a key (memory, then disk) — what the popup server serves. Sync, small. */
  pngFor(key: string): Uint8Array | null {
    if (!/^[0-9a-f]{32}$/.test(key)) return null;
    for (const e of this.mem.values()) if (e.key === key && e.state.state === 'ready') return e.state.png;
    const b = this.disk.get(key);
    return b ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : null;
  }

  snapshot(): ImageServiceStats {
    let ready = 0, missing = 0, pending = 0;
    for (const e of this.mem.values()) { if (e.state.state === 'ready') ready++; else if (e.state.state === 'missing') missing++; else pending++; }
    return { ...this.stats, known: this.mem.size, ready, missing, pending, inflight: this.inflightUrls.size, queued: this.queue.length };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort(new Error('closing'));
    this.queue.length = 0;
    for (const j of this.jobs.values()) { clearTimeout(j.timer); j.resolve({ id: 0, ok: false, error: 'closing' }); }
    this.jobs.clear();
    if (this.worker) { void this.worker.terminate().catch(() => {}); this.worker = null; }
  }

  private now(): number { return this.opts.now ? this.opts.now() : Date.now(); }

  private hostOf(url: string): string { try { return new URL(url).hostname; } catch { return '?'; } }

  private pump(): void {
    if (this.closed) return;
    while (this.inflightUrls.size < this.opts.concurrency && this.queue.length) {
      // highest priority, then most recently asked for
      let best = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const e = this.queue[i];
        const host = this.hostOf(e.url);
        if ((this.perHostInflight.get(host) ?? 0) >= this.opts.perHost) continue;
        if (best < 0 || e.priority > this.queue[best].priority || (e.priority === this.queue[best].priority && e.seq > this.queue[best].seq)) best = i;
      }
      if (best < 0) return;
      const [e] = this.queue.splice(best, 1);
      void this.run(e);
    }
  }

  private settle(e: Entry, state: ImageState): void {
    e.state = state;
    e.at = this.now();
    if (state.state === 'ready') {
      this.mem.delete(e.url); this.mem.set(e.url, e);
      // memory LRU: drop the oldest READY entries past the cap (pending/missing are tiny)
      let readyCount = 0;
      for (const x of this.mem.values()) if (x.state.state === 'ready') readyCount++;
      if (readyCount > this.opts.maxMemory) {
        for (const [k, x] of this.mem) {
          if (x.state.state !== 'ready') continue;
          this.mem.delete(k); readyCount--;
          if (readyCount <= this.opts.maxMemory) break;
        }
      }
    }
    if (!this.closed) this.onChange?.();
  }

  private async run(e: Entry): Promise<void> {
    const host = this.hostOf(e.url);
    this.inflightUrls.add(e.url);
    this.perHostInflight.set(host, (this.perHostInflight.get(host) ?? 0) + 1);
    const t0 = this.now();
    try {
      // 1. disk cache (our own PNG) — fresh or not, it is the thumbnail we last made for this URL
      const cached = this.disk.get(e.key);
      if (cached) {
        try {
          const img = decodePng(cached);
          this.stats.diskHits += 1;
          this.opts.onRequest?.({ url: e.url, ok: true, bytes: cached.length, ms: this.now() - t0, reason: null, source: 'disk' });
          this.settle(e, { state: 'ready', img, png: new Uint8Array(cached.buffer, cached.byteOffset, cached.byteLength), key: e.key });
          return;
        } catch { /* corrupt file: fall through and refetch */ }
      }
      if (this.disk.failed(e.key)) { this.settle(e, { state: 'missing', reason: 'failed recently', key: e.key }); return; }
      if (this.opts.offline) {
        this.opts.onRequest?.({ url: e.url, ok: false, bytes: 0, ms: 0, reason: 'offline', source: 'offline' });
        this.settle(e, { state: 'missing', reason: 'offline', key: e.key });
        return;
      }
      // 2. network
      const target = (this.opts.rewrite ?? thumbnailUrl)(e.url);
      const res = this.opts.fetch ? await this.opts.fetch(target, this.abort.signal) : await fetchBytes(target, { signal: this.abort.signal });
      if (this.closed) return;
      if (!res.ok) {
        this.stats.fetchFailed += 1;
        this.opts.onRequest?.({ url: target, ok: false, bytes: 0, ms: res.elapsedMs, reason: res.reason, source: 'network' });
        // a 4xx (not 429) or a policy refusal is durable (marked on disk); a 429 / timeout / 5xx is transient and
        // retried after a backoff within this session (public IPFS gateways rate-limit in bursts)
        const policy = res.status === 0 && !/timed out|fetch failed/.test(res.reason ?? '');
        const durable = policy || (res.status >= 400 && res.status < 500 && res.status !== 429);
        if (durable) this.disk.markFailed(e.key, res.reason ?? 'http');
        e.attempts += 1;
        const wait = durable ? undefined : RETRY_BACKOFF_MS[e.attempts - 1];
        this.settle(e, { state: 'missing', reason: res.reason ?? 'fetch failed', key: e.key, ...(wait !== undefined ? { retryAt: this.now() + wait } : {}) });
        return;
      }
      this.stats.fetched += 1;
      this.stats.bytesFetched += res.bytes.length;
      // 3. decode (worker thread), 4. store, 5. notify
      const td = this.now();
      const d = await this.decode(res.bytes);
      this.stats.decodes += 1;
      this.stats.decodeMsTotal += this.now() - td;
      if (this.closed) return;
      if (!d.ok) {
        this.stats.decodeFailed += 1;
        this.opts.onRequest?.({ url: target, ok: false, bytes: res.bytes.length, ms: this.now() - t0, reason: d.error, source: 'network' });
        this.disk.markFailed(e.key, d.error);
        this.settle(e, { state: 'missing', reason: d.error, key: e.key });
        return;
      }
      this.disk.put(e.key, d.png);
      this.opts.onRequest?.({ url: target, ok: true, bytes: res.bytes.length, ms: this.now() - t0, reason: null, source: 'network' });
      this.settle(e, { state: 'ready', img: { w: d.w, h: d.h, rgba: d.rgba }, png: d.png, key: e.key });
    } catch (err) {
      if (!this.closed) this.settle(e, { state: 'missing', reason: (err as Error).message ?? 'error', key: e.key });
    } finally {
      this.inflightUrls.delete(e.url);
      this.perHostInflight.set(host, Math.max(0, (this.perHostInflight.get(host) ?? 1) - 1));
      this.pump();
      if (this.idle && this.idleWaiters.length) { const ws = this.idleWaiters; this.idleWaiters = []; for (const w of ws) w(); }
    }
  }

  private decode(bytes: Uint8Array): Promise<DecodeReply> {
    if (this.opts.decode) return this.opts.decode(bytes, this.opts.thumbMax);
    const w = this.ensureWorker();
    const id = ++this.jobId;
    const job: DecodeJob = { id, bytes: new Uint8Array(bytes), thumbMax: this.opts.thumbMax };
    if (!w) { this.stats.workerFallbacks += 1; return Promise.resolve(runDecodeJob(job)); }
    return new Promise<DecodeReply>((resolve) => {
      // A decode that takes more than 10 s is pathological input: kill the worker, fail the job, rebuild lazily.
      const timer = setTimeout(() => { this.jobs.delete(id); this.breakWorker(); resolve({ id, ok: false, error: 'decode timed out' }); }, 10_000);
      (timer as { unref?: () => void }).unref?.();
      this.jobs.set(id, { resolve, timer });
      try { w.postMessage(job, [job.bytes.buffer as ArrayBuffer]); } catch (e) { clearTimeout(timer); this.jobs.delete(id); resolve({ id, ok: false, error: (e as Error).message }); }
    });
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (this.workerBroken || this.closed) return null;
    try {
      const w = new Worker(new URL('./decode-worker.ts', import.meta.url));
      w.unref(); // a worker alone never keeps the process alive (quit stays instant)
      w.on('message', (r: DecodeReply) => {
        const j = this.jobs.get(r.id);
        if (!j) return;
        clearTimeout(j.timer); this.jobs.delete(r.id); j.resolve(r);
      });
      w.on('error', (e) => { this.failJobs(`worker error: ${e instanceof Error ? e.message : String(e)}`); this.breakWorker(); });
      w.on('exit', () => { if (this.worker === w) this.worker = null; this.failJobs('worker exited'); });
      this.worker = w;
      return w;
    } catch {
      this.workerBroken = true; // main-thread fallback from now on
      return null;
    }
  }

  private failJobs(reason: string): void {
    for (const [id, j] of this.jobs) { clearTimeout(j.timer); j.resolve({ id, ok: false, error: reason }); }
    this.jobs.clear();
  }

  private breakWorker(): void {
    const w = this.worker; this.worker = null;
    if (w) void w.terminate().catch(() => {});
  }
}
