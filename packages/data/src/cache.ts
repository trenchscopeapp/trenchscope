// SQLite cache (SPEC §3.4) on Node's built-in `node:sqlite`.
//
// Why node:sqlite over better-sqlite3: it ships with Node >= 22.5 (verified on
// 24.20), so there is no native addon to compile per platform/ABI, which keeps
// `npx dexterm` and the Homebrew formula dependency-free. The API is synchronous
// like better-sqlite3, which suits a cache. Trade-offs: it is still flagged
// experimental in Node 24 and `bun build --compile` binaries would need a
// bun:sqlite shim behind this same class (D-22).
//
// One table, namespaced: (ns, key) -> json, fetched_at, ttl_ms, source.
// fetch() layers in-flight coalescing and stale-while-revalidate on top.

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Clock } from './clock.ts';
import { systemClock } from './clock.ts';
import type { SourceId } from './model.ts';

/** TTLs from SPEC §3.4 (ms). `lists` (boosts/trending/recent feeds) is ours: they refresh at 15-30 s. */
export const TTL = {
  pairs: 10_000,
  enrichment: 60_000,
  price: 30_000,
  candlesOpen: 30_000,
  candlesClosed: 3_600_000,
  holders: 60_000,
  audit: 600_000,
  rugcheck: 600_000,
  /** Solana Tracker risk: holder-side numbers (snipers selling, dev dumping) move fast on fresh coins. */
  tracker: 120_000,
  /** Shrine 1 s history: the token screen refreshes every 10 s, so each refresh sees the newest seconds. */
  shrine: 10_000,
  socials: 3_600_000,
  devHistory: 86_400_000,
  lists: 15_000,
} as const;

export interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
  ttlMs: number;
  source: SourceId | null;
  ageMs: number;
  stale: boolean;
}

export interface FetchResult<T> {
  value: T;
  fetchedAt: number;
  source: SourceId | null;
  fromCache: boolean;
  stale: boolean;
  /** Set when the loader failed and a stale value was served instead. */
  error?: Error;
  /** Background refresh started for a stale hit (SWR); resolves when it settles. */
  refreshing?: Promise<void>;
}

export interface FetchOptions {
  ttlMs: number;
  source?: SourceId;
  /** Serve stale values immediately and refresh in the background (default true). */
  swr?: boolean;
}

/** XDG data path for the cache DB (SPEC §2.2). Pure: does not create anything. */
export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'dexterm', 'dexterm.db');
  const base = env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'dexterm', 'dexterm.db');
}

export interface CacheOptions {
  /** File path or ':memory:' (default). */
  path?: string;
  clock?: Clock;
}

export class Cache {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(opts: CacheOptions = {}) {
    const path = opts.path ?? ':memory:';
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.clock = opts.clock ?? systemClock;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS cache (
        ns TEXT NOT NULL,
        key TEXT NOT NULL,
        json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        ttl_ms INTEGER NOT NULL,
        source TEXT,
        PRIMARY KEY (ns, key)
      ) WITHOUT ROWID;
    `);
  }

  get<T>(ns: string, key: string): CacheEntry<T> | undefined {
    const row = this.db
      .prepare('SELECT json, fetched_at, ttl_ms, source FROM cache WHERE ns = ? AND key = ?')
      .get(ns, key) as { json: string; fetched_at: number; ttl_ms: number; source: string | null } | undefined;
    if (!row) return undefined;
    const ageMs = this.clock.now() - row.fetched_at;
    return {
      value: JSON.parse(row.json) as T,
      fetchedAt: row.fetched_at,
      ttlMs: row.ttl_ms,
      source: row.source as SourceId | null,
      ageMs,
      stale: ageMs >= row.ttl_ms,
    };
  }

  set<T>(ns: string, key: string, value: T, opts: { ttlMs: number; source?: SourceId; fetchedAt?: number }): void {
    this.db
      .prepare('INSERT OR REPLACE INTO cache (ns, key, json, fetched_at, ttl_ms, source) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ns, key, JSON.stringify(value), opts.fetchedAt ?? this.clock.now(), opts.ttlMs, opts.source ?? null);
  }

  delete(ns: string, key: string): void {
    this.db.prepare('DELETE FROM cache WHERE ns = ? AND key = ?').run(ns, key);
  }

  /** Drop entries older than ttl + `graceMs` (stale data is still useful for degraded mode). */
  prune(graceMs = 86_400_000): number {
    const res = this.db.prepare('DELETE FROM cache WHERE fetched_at + ttl_ms + ? < ?').run(graceMs, this.clock.now());
    return Number(res.changes);
  }

  count(ns?: string): number {
    const row = (ns === undefined
      ? this.db.prepare('SELECT COUNT(*) AS n FROM cache').get()
      : this.db.prepare('SELECT COUNT(*) AS n FROM cache WHERE ns = ?').get(ns)) as { n: number };
    return Number(row.n);
  }

  /** Keep only the newest entries in a long-running public service. Local clients opt in explicitly. */
  trim(maxEntries: number): number {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) throw new Error('maxEntries must be a non-negative integer');
    const res = this.db.prepare('DELETE FROM cache WHERE (ns, key) IN (SELECT ns, key FROM cache ORDER BY fetched_at DESC, ns, key LIMIT -1 OFFSET ?)').run(maxEntries);
    return Number(res.changes);
  }

  /**
   * Cached load with coalescing (identical concurrent loads share one promise)
   * and stale-while-revalidate. On loader failure a stale value is served with
   * `error` set; with nothing cached the error propagates.
   */
  async fetch<T>(ns: string, key: string, loader: () => Promise<T>, opts: FetchOptions): Promise<FetchResult<T>> {
    const hit = this.get<T>(ns, key);
    if (hit && !hit.stale) {
      return { value: hit.value, fetchedAt: hit.fetchedAt, source: hit.source, fromCache: true, stale: false };
    }
    if (hit && (opts.swr ?? true)) {
      const refreshing = this.load(ns, key, loader, opts).then(
        () => undefined,
        () => undefined,
      );
      return { value: hit.value, fetchedAt: hit.fetchedAt, source: hit.source, fromCache: true, stale: true, refreshing };
    }
    try {
      const value = await this.load(ns, key, loader, opts);
      return { value, fetchedAt: this.clock.now(), source: opts.source ?? null, fromCache: false, stale: false };
    } catch (err) {
      if (!hit) throw err;
      return { value: hit.value, fetchedAt: hit.fetchedAt, source: hit.source, fromCache: true, stale: true, error: err as Error };
    }
  }

  close(): void {
    this.db.close();
  }

  private load<T>(ns: string, key: string, loader: () => Promise<T>, opts: FetchOptions): Promise<T> {
    const id = `${ns}\u0000${key}`;
    const existing = this.inflight.get(id);
    if (existing) return existing as Promise<T>;
    const p = (async () => {
      try {
        const value = await loader();
        this.set(ns, key, value, { ttlMs: opts.ttlMs, source: opts.source });
        return value;
      } finally {
        this.inflight.delete(id);
      }
    })();
    this.inflight.set(id, p);
    return p;
  }
}
