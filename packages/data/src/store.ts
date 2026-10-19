// Store: per-mint cached enrichment (DexScreener pair + Jupiter token/stats/audit
// + optional Jupiter price) and preset discovery feeds. Sources are fetched in
// parallel; a failed or degraded source degrades rows instead of failing them,
// and stale cache entries are served (flagged) when a refresh fails.

import type { Cache } from './cache.ts';
import { TTL } from './cache.ts';
import type { DexScreener, DsTokenView } from './sources/dexscreener.ts';
import type { Jupiter, JupPrice, JupTokenView } from './sources/jupiter.ts';
import type { SourceId, Token, TokenSnapshot } from './model.ts';

export interface EnrichedRow extends TokenSnapshot {
  mint: string;
  price?: JupPrice;
  /** Sources that contributed to this row. */
  sources: SourceId[];
  /** True when any part came from an expired cache entry because the refresh failed. */
  stale: boolean;
  /** MCAP column value after the cross-source check (see resolveMcap). `pair.mcap` stays raw. */
  mcap?: McapResolution;
}

export interface McapResolution {
  value: number | null;
  basis: 'dexscreener' | 'jupiter' | null;
  /** Sources disagree by more than MCAP_AGREE_RATIO: show the value dimmed with a warning. */
  flagged: boolean;
  dexscreener: number | null;
  jupiter: number | null;
}

/** Max ratio between DexScreener and Jupiter market caps for them to count as agreeing. */
export const MCAP_AGREE_RATIO = 5;

/**
 * MCAP rule (D-02 open decision, resolved in D-06): DexScreener's pair `marketCap`
 * (or `fdv` when absent) can reflect only the Solana-side supply of bridged/wrapped
 * tokens. Take the larger of DexScreener and Jupiter `mcap` when they agree within
 * 5x; otherwise keep DexScreener's number and flag the row. One side only: use it.
 */
export function resolveMcap(ds: { mcap: number | null; fdv: number | null } | undefined, jupMcap: number | null | undefined): McapResolution {
  const d = ds ? (ds.mcap ?? ds.fdv) : null;
  const j = jupMcap ?? null;
  const pos = (n: number | null) => n !== null && Number.isFinite(n) && n > 0;
  if (pos(d) && pos(j)) {
    const ratio = Math.max(d!, j!) / Math.min(d!, j!);
    if (ratio <= MCAP_AGREE_RATIO) {
      return j! > d! ? { value: j, basis: 'jupiter', flagged: false, dexscreener: d, jupiter: j } : { value: d, basis: 'dexscreener', flagged: false, dexscreener: d, jupiter: j };
    }
    return { value: d, basis: 'dexscreener', flagged: true, dexscreener: d, jupiter: j };
  }
  if (pos(d)) return { value: d, basis: 'dexscreener', flagged: false, dexscreener: d, jupiter: j };
  if (pos(j)) return { value: j, basis: 'jupiter', flagged: false, dexscreener: d, jupiter: j };
  return { value: null, basis: null, flagged: false, dexscreener: d, jupiter: j };
}

export interface EnrichResult {
  rows: EnrichedRow[];
  /** Requested mints no source could describe. */
  missing: string[];
  /** Wall time per source for this call (includes limiter queueing); absent when served from cache. */
  latencyMs: Partial<Record<SourceId, number>>;
  errors: Partial<Record<SourceId, string>>;
}

export type Preset = 'trending' | 'organic' | 'recent' | 'traded' | 'boosted';

export interface DiscoverResult {
  mints: string[];
  /** Which feed(s) surfaced each mint. */
  origin: Record<string, string[]>;
  errors: Partial<Record<SourceId, string>>;
}

/**
 * Observation hook (task-1329, AI-SUITE-DESIGN §4.1 "snapshot on change from the data layer's
 * normaliser"). The history recorder listens here so it sees exactly the rows the app already holds and
 * never issues a request of its own. `onEnrich` fires once per enrich() call with the normalised rows
 * (fresh or cached); `onDiscover` once per discover() with each sub-feed's mint list in rank order.
 * A listener that throws is dropped for that call: it can never break a refresh.
 */
export interface StoreListener {
  onEnrich?(ev: EnrichEvent): void;
  onDiscover?(ev: DiscoverEvent): void;
}

export interface EnrichEvent {
  rows: EnrichedRow[];
  /** Clock reading when the call finished (the rows carry their own fetchedAt). */
  t: number;
  /** True when at least one source was fetched (not every row served from cache). */
  fetched: boolean;
}

export interface DiscoverEvent {
  preset: Preset;
  pool: boolean;
  t: number;
  feeds: { name: string; source: SourceId; mints: string[] }[];
}

const NS = { ds: 'ds:token', jup: 'jup:token', price: 'jup:price', list: 'list' } as const;

interface Lookup<T> {
  values: Map<string, T>;
  stale: Set<string>;
  latencyMs?: number;
  error?: string;
}

export class Store {
  private readonly cache: Cache;
  private readonly ds: DexScreener;
  private readonly jup: Jupiter;
  /** Observation hook (task-1329); null = nobody listening. */
  listener: StoreListener | null = null;

  constructor(deps: { cache: Cache; dexscreener: DexScreener; jupiter: Jupiter }) {
    this.cache = deps.cache;
    this.ds = deps.dexscreener;
    this.jup = deps.jupiter;
  }

  private emitEnrich(rows: EnrichedRow[], fetched: boolean): void {
    const l = this.listener;
    if (!l?.onEnrich || rows.length === 0) return;
    try { l.onEnrich({ rows, t: Date.now(), fetched }); } catch { /* a listener never breaks a refresh */ }
  }

  private emitDiscover(ev: DiscoverEvent): void {
    const l = this.listener;
    if (!l?.onDiscover) return;
    try { l.onDiscover(ev); } catch { /* a listener never breaks a refresh */ }
  }

  /**
   * `jup: 'cache'` (task-1323) serves the Jupiter token records from the cache only (fresh or stale) and
   * never queues a Jupiter search: the first screener paint must not wait behind the keyless Jupiter
   * bucket (one call per ~2.9 s, 429-prone). Jupiter list calls seed exactly those records, so rows from
   * a Jupiter list stay fully enriched; others paint DexScreener-only and fill in on the next pass.
   */
  async enrich(mints: string[], opts: { price?: boolean; jup?: 'network' | 'cache' } = {}): Promise<EnrichResult> {
    const unique = [...new Set(mints)];
    const jupCacheOnly = opts.jup === 'cache';
    const [ds, jup, price] = await Promise.all([
      this.lookup<DsTokenView>(NS.ds, unique, TTL.pairs, 'dexscreener', (m) => this.ds.tokens(m)),
      jupCacheOnly ? Promise.resolve(this.cached<JupTokenView>(NS.jup, unique)) : this.lookup<JupTokenView>(NS.jup, unique, TTL.enrichment, 'jupiter-tokens', async (m) => {
        const views = await this.jup.search(m);
        return new Map(views.map((v) => [v.token.mint, v]));
      }),
      opts.price
        ? this.lookup<JupPrice>(NS.price, unique, TTL.price, 'jupiter-price', (m) => this.jup.price(m))
        : Promise.resolve<Lookup<JupPrice>>({ values: new Map(), stale: new Set() }),
    ]);

    const rows: EnrichedRow[] = [];
    const missing: string[] = [];
    for (const mint of unique) {
      const d = ds.values.get(mint);
      const j = jup.values.get(mint);
      const p = price.values.get(mint);
      const pair = d?.pair ?? j?.pair;
      if (!pair || (!d && !j)) {
        missing.push(mint);
        continue;
      }
      const sources: SourceId[] = [];
      if (d) sources.push('dexscreener');
      if (j) sources.push('jupiter-tokens');
      if (p) sources.push('jupiter-price');
      rows.push({
        mint,
        token: mergeToken(d?.token, j?.token),
        pair,
        stats: j?.stats,
        audit: j?.audit,
        price: p,
        sources,
        stale: ds.stale.has(mint) || jup.stale.has(mint) || price.stale.has(mint),
        mcap: resolveMcap(d?.pair, j?.pair.mcap),
      });
    }

    const latencyMs: EnrichResult['latencyMs'] = {};
    const errors: EnrichResult['errors'] = {};
    const per: [SourceId, Lookup<unknown>][] = [['dexscreener', ds], ['jupiter-tokens', jup], ['jupiter-price', price]];
    for (const [s, l] of per) {
      if (l.latencyMs !== undefined) latencyMs[s] = l.latencyMs;
      if (l.error) errors[s] = l.error;
    }
    this.emitEnrich(rows, Object.keys(latencyMs).length > 0);
    return { rows, missing, latencyMs, errors };
  }

  /**
   * Mints for a preset feed (SPEC §4.2). Two sizes:
   *  - default (`opts.max` unset): the compact feed (one or two lists), capped at `limit` — the
   *    historical behaviour the MCP tool and the recording scripts rely on.
   *  - pool mode (`opts.max` set, task-1303): a much wider candidate net — Jupiter
   *    toptrending/toporganicscore/toptraded across 5m/1h/24h (up to `limit` each, keyless pacing)
   *    plus DexScreener boosts (top + latest) and the latest token profiles — de-duplicated by mint
   *    and capped at `opts.max`. This is how the screener fills hundreds of rows.
   */
  async discover(preset: Preset, limit = 30, opts: { max?: number } = {}): Promise<DiscoverResult> {
    const pool = opts.max !== undefined;
    const max = opts.max ?? limit;
    const feeds = this.discoverFeeds(preset, limit, pool);

    const errors: DiscoverResult['errors'] = {};
    const lists = await Promise.all(
      feeds.map(async (f) => {
        try {
          const r = await this.cache.fetch<string[]>(NS.list, f.name, f.load, { ttlMs: TTL.lists, source: f.source, swr: false });
          return r.value;
        } catch (err) {
          errors[f.source] = errMsg(err);
          return [] as string[];
        }
      }),
    );

    this.emitDiscover({ preset, pool, t: Date.now(), feeds: feeds.map((f, i) => ({ name: f.name, source: f.source, mints: lists[i] })) });

    // Interleave feeds so every source is represented near the top.
    const origin: Record<string, string[]> = {};
    const mints: string[] = [];
    const longest = Math.max(0, ...lists.map((l) => l.length));
    for (let i = 0; i < longest && mints.length < max; i++) {
      for (let f = 0; f < lists.length && mints.length < max; f++) {
        const m = lists[f][i];
        if (!m) continue;
        (origin[m] ??= []).push(feeds[f].name);
        if (origin[m].length === 1) mints.push(m);
      }
    }
    return { mints, origin, errors };
  }

  /** The discovery sub-feeds for a preset. Compact by default; a wide net in pool mode (task-1303). */
  private discoverFeeds(preset: Preset, limit: number, pool: boolean): { name: string; source: SourceId; load: () => Promise<string[]> }[] {
    const feeds: { name: string; source: SourceId; load: () => Promise<string[]> }[] = [];
    const jupCat = (cat: 'toptrending' | 'toporganicscore' | 'toptraded', iv: '5m' | '1h' | '6h' | '24h') =>
      feeds.push({ name: `jup:${cat}-${iv}`, source: 'jupiter-tokens', load: () => this.jupList(() => this.jup.category(cat, iv, limit)) });
    if (preset === 'trending') {
      // Compact order is load-bearing: recordings/replays enrich exactly this mint set (do not reorder).
      feeds.push({ name: 'ds:boosts-top', source: 'dexscreener', load: async () => (await this.ds.boostsTop()).map((b) => b.mint) });
      feeds.push({ name: 'jup:toptrending-1h', source: 'jupiter-tokens', load: () => this.jupList(() => this.jup.category('toptrending', '1h', limit)) });
      if (pool) {
        jupCat('toptrending', '24h');
        jupCat('toptraded', '24h');
        jupCat('toptrending', '5m');
        feeds.push({ name: 'ds:boosts-latest', source: 'dexscreener', load: async () => (await this.ds.boostsLatest()).map((b) => b.mint) });
        feeds.push({ name: 'ds:profiles-latest', source: 'dexscreener', load: () => this.ds.profilesLatest() });
      }
    } else if (preset === 'organic') {
      feeds.push({ name: 'jup:toporganicscore-1h', source: 'jupiter-tokens', load: () => this.jupList(() => this.jup.category('toporganicscore', '1h', limit)) });
      if (pool) {
        jupCat('toporganicscore', '24h');
        jupCat('toporganicscore', '5m');
      }
    } else if (preset === 'traded') {
      // Top-traded by volume (task-1303): the 'top traded' feed switcher entry.
      feeds.push({ name: 'jup:toptraded-1h', source: 'jupiter-tokens', load: () => this.jupList(() => this.jup.category('toptraded', '1h', limit)) });
      if (pool) {
        jupCat('toptraded', '24h');
        jupCat('toptraded', '5m');
        jupCat('toptrending', '1h');
      }
    } else if (preset === 'boosted') {
      // Paid-boosted + freshly-listed tokens (task-1303): the 'boosted' feed switcher entry (DexScreener only).
      feeds.push({ name: 'ds:boosts-top', source: 'dexscreener', load: async () => (await this.ds.boostsTop()).map((b) => b.mint) });
      if (pool) {
        feeds.push({ name: 'ds:boosts-latest', source: 'dexscreener', load: async () => (await this.ds.boostsLatest()).map((b) => b.mint) });
        feeds.push({ name: 'ds:profiles-latest', source: 'dexscreener', load: () => this.ds.profilesLatest() });
      }
    } else {
      feeds.push({ name: 'jup:recent', source: 'jupiter-tokens', load: () => this.jupList(() => this.jup.recent()) });
      if (pool) {
        jupCat('toptrending', '5m');
        feeds.push({ name: 'ds:profiles-latest', source: 'dexscreener', load: () => this.ds.profilesLatest() });
      }
    }
    return feeds;
  }

  /** Jupiter list endpoints return full token records: seed the enrichment cache from them. */
  private async jupList(load: () => Promise<JupTokenView[]>): Promise<string[]> {
    const views = await load();
    for (const v of views) this.cache.set(NS.jup, v.token.mint, v, { ttlMs: TTL.enrichment, source: 'jupiter-tokens', fetchedAt: v.token.fetchedAt });
    return views.map((v) => v.token.mint);
  }

  /** Cache-only lookup: fresh and stale hits, no network (stale ones flagged like a failed refresh). */
  private cached<T>(ns: string, mints: string[]): Lookup<T> {
    const out: Lookup<T> = { values: new Map(), stale: new Set() };
    for (const m of mints) {
      const hit = this.cache.get<T>(ns, m);
      if (!hit) continue;
      out.values.set(m, hit.value);
      if (hit.stale) out.stale.add(m);
    }
    return out;
  }

  private async lookup<T>(
    ns: string,
    mints: string[],
    ttlMs: number,
    source: SourceId,
    fetchMany: (mints: string[]) => Promise<Map<string, T>>,
  ): Promise<Lookup<T>> {
    const values = new Map<string, T>();
    const staleHits = new Map<string, T>();
    const need: string[] = [];
    for (const m of mints) {
      const hit = this.cache.get<T>(ns, m);
      if (hit && !hit.stale) values.set(m, hit.value);
      else {
        if (hit) staleHits.set(m, hit.value);
        need.push(m);
      }
    }
    const out: Lookup<T> = { values, stale: new Set() };
    if (need.length === 0) return out;
    const t0 = performance.now();
    try {
      const fetched = await fetchMany(need);
      out.latencyMs = Math.round(performance.now() - t0);
      for (const [m, v] of fetched) {
        this.cache.set(ns, m, v, { ttlMs, source });
        values.set(m, v);
      }
    } catch (err) {
      out.error = errMsg(err);
      for (const [m, v] of staleHits) {
        values.set(m, v);
        out.stale.add(m);
      }
    }
    return out;
  }
}

/**
 * Jupiter is preferred for identity fields (decimals, launchpad, verification); DexScreener fills gaps.
 * The image is the exception (task-1326): DexScreener's CDN rendition first (small, transcoded, served from
 * one reliable host), Jupiter's icon only when DexScreener has none — Jupiter icons are usually raw IPFS
 * gateway links (the main public IPFS gateway answered 429 for 16 of 40 in the task-1326 live run).
 */
export function mergeToken(ds: Token | undefined, jup: Token | undefined): Token {
  if (!jup) return ds!;
  if (!ds) return jup;
  return {
    ...jup,
    launchpad: jup.launchpad !== 'unknown' ? jup.launchpad : ds.launchpad,
    createdAt: jup.createdAt ?? ds.createdAt,
    image: ds.image ?? jup.image,
    socials: { x: jup.socials.x ?? ds.socials.x, tg: jup.socials.tg ?? ds.socials.tg, web: jup.socials.web ?? ds.socials.web },
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
