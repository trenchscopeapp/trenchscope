// trenchscope — the screener's feed on top of @dexterm/data (D-02/D-04/D-06): discovery per preset,
// enrichment of the mints, health → header status, column gates. Live (keyless, read-only),
// recorded while live, or replayed from a recorded fixture file (offline, same code path, no network).
import { readFileSync } from 'node:fs';
import {
  createDataLayer, FixtureStore, replayTransport, recordingTransport, liveTransport, gateAll, COLUMN_SOURCES, DEFAULT_BUCKETS,
  type DataLayer, type DataLayerOptions, type Gate, type SourceId, type Preset as FeedPreset, type Transport,
} from '@dexterm/data/core';
import { redactSecrets } from '@dexterm/data/core';
import { fromSnapshot, type ScreenerRow } from './screener/rows.ts';
import { PRESETS, presetSpec, presetViews, bakedFilter, type PresetId, type PresetView } from './screener/presets.ts';
import { applyFilter } from './screener/filter.ts';

export interface FeedOptions {
  /** Clock for ages and "refreshed N s ago"; defaults to Date.now (replay pins it to the recording). */
  now?: () => number;
  /** Per-list API limit asked of each discovery feed (Jupiter lists accept up to 100). */
  limit?: number;
  /** Hard cap on the de-duplicated candidate pool per refresh (task-1303). */
  poolMax?: number;
  /**
   * Pull the wide candidate pool (task-1303): extra Jupiter windows + DexScreener boosts/profiles,
   * for hundreds of rows. Off by default so recordings/replays stay byte-identical; `createLiveFeed`
   * turns it on. Pool mode requests `?limit=<PER_LIST>` lists that recordings (made at 30) do not have.
   */
  wide?: boolean;
  /** Soft DexScreener budget for the wide-pool background fill (task-1303); defaults to DS_TARGET_RPM. */
  dsTargetRpm?: number;
  /** Starting preset. Default 'trending'; `createLiveFeed` opens on the trench feed (task-1311, QA M4). */
  preset?: PresetId;
  /**
   * Persist the last rendered rows per preset in the data layer's SQLite cache and restore them before
   * the first network fetch (task-1323), so a launch paints the last feed instantly, marked stale until
   * the refresh lands. Off by default (tests/replays); `createLiveFeed` turns it on.
   */
  snapshot?: boolean;
  /**
   * First paint from ONE list (task-1323): when nothing fresh is on screen, the refresh enriches the
   * preset's first discovery feed with DexScreener only (Jupiter records come from the list call's cache
   * seed, never a queued Jupiter search) and paints, before the remaining lists. Off by default so
   * recordings/replays keep their exact request set; `createLiveFeed` turns it on.
   */
  fastFirstPaint?: boolean;
  /**
   * Boot fallback (task-1323): if the starting preset shows zero rows after `afterMs` (nothing cached,
   * first fetch slow) or its first refresh comes back empty, switch to `preset`. `createLiveFeed` sets
   * { preset: 'trending', afterMs: FALLBACK_AFTER_MS }.
   */
  fallback?: { preset: PresetId; afterMs: number } | null;
}

/** Feed snapshot rows (task-1323): cache namespace, rows kept, retention and write throttle. */
export const SNAPSHOT_NS = 'feed:snapshot';
export const SNAPSHOT_MAX_ROWS = 200;
export const SNAPSHOT_TTL_MS = 7 * 86_400_000;
export const SNAPSHOT_SAVE_MS = 30_000;
/** Boot fallback budget (task-1323): the default feed gets this long to show a row before Trending takes over. */
export const FALLBACK_AFTER_MS = 2_500;

interface FeedSnapshot { v: 1; preset: PresetId; pool: number; rows: ScreenerRow[] }

/** Per-list API limit (Jupiter toptrending/organic/traded accept up to 100). */
export const PER_LIST = 100;
/** De-duplicated candidate-pool cap per refresh: hundreds of rows without hammering the sources. */
export const POOL_MAX = 500;
/** Enrich the pool in batches this big so rows paint progressively instead of in one jump. */
export const ENRICH_CHUNK = 75;
/**
 * Self-imposed DexScreener budget for the wide-pool background fill (task-1303). The FAST
 * tokens/v1 bucket is documented at 300 rpm, but a real interactive run (live feeds, 134 s idle)
 * drove it to ~58 req/min — too close to the 60 rpm the SLOW endpoints share and enough to earn a
 * 429. The background fill paces itself to this ceiling (well under the fast bucket's budget), so
 * the visible rows paint at full speed while the long tail trickles in. Phase-1 (compact) and
 * visible-first batches are NOT paced — the user always gets a fast first screen.
 */
export const DS_TARGET_RPM = 24;
/** Each DexScreener token call covers 30 mints; one ENRICH_CHUNK is ceil(75/30)=3 calls. */
const DS_TOKENS_BATCH = 30;

function chunkMints(xs: string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** `42s` / `4m` / `3h` / `2d` for an age in ms. */
function agoLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
}

/**
 * A minimal rolling-window pacer for the wide-pool background fill. It is NOT the data layer's rate
 * limiter (that enforces the hard documented ceilings and honours Retry-After); this is a softer,
 * self-imposed DexScreener budget layered on top so the wide pool cannot creep toward the 60 rpm
 * shared cap. `wait()` returns the ms to sleep before issuing `cost` more DexScreener calls.
 */
export class DsPacer {
  private readonly stamps: number[] = [];
  private readonly rpm: number;
  private readonly now: () => number;
  constructor(rpm: number, now: () => number) { this.rpm = rpm; this.now = now; }
  /** Record `n` DexScreener calls as issued at the current clock. */
  spent(n: number): void {
    const t = this.now();
    for (let i = 0; i < n; i++) this.stamps.push(t);
  }
  /** ms to wait before issuing `cost` more calls without exceeding the rolling 60 s budget. */
  wait(cost: number): number {
    const t = this.now();
    while (this.stamps.length && this.stamps[0] + 60_000 <= t) this.stamps.shift();
    const budget = this.rpm;
    if (this.stamps.length + cost <= budget) return 0;
    // Need (stamps + cost - budget) slots to free up; wait until that many oldest fall out of the window.
    const need = this.stamps.length + cost - budget;
    const idx = Math.min(need - 1, this.stamps.length - 1);
    return idx >= 0 ? Math.max(0, this.stamps[idx] + 60_000 - t) : 0;
  }
  /** Calls issued in the trailing 60 s (for the measured req/min the handoff reports). */
  rate(): number {
    const t = this.now();
    while (this.stamps.length && this.stamps[0] + 60_000 <= t) this.stamps.shift();
    return this.stamps.length;
  }
}

export interface FeedStatus {
  /** `◐ degraded: jup` style header status, or undefined when every used source is fine. */
  headerStatus?: string;
  feedLabel: string;
  errors: Partial<Record<SourceId, string>>;
}

const SHORT: Partial<Record<SourceId, string>> = { dexscreener: 'dexscreener', 'jupiter-tokens': 'jup', 'jupiter-price': 'jup', geckoterminal: 'gecko', rugcheck: 'rugcheck', helius: 'helius', pumpfun: 'pump.fun' };

export class ScreenerFeed {
  readonly dl: DataLayer;
  readonly now: () => number;
  readonly limit: number;
  preset: PresetId = 'trending';
  rows: ScreenerRow[] = [];
  errors: Partial<Record<SourceId, string>> = {};
  /** Epoch ms of the last completed refresh (null before the first). */
  refreshedAt: number | null = null;
  refreshing = false;
  /** Called after each incremental batch of rows lands during a refresh, so the UI can paint the fill. */
  onProgress: (() => void) | null = null;
  /**
   * Extra candidate mints to fold into the wide pool for live-backed presets (task-1303): the
   * interactive loop points this at the PumpPortal new-pairs stream so "New"/"All" surface the
   * freshest launches the REST feeds have not indexed yet. Off for replay/fixtures.
   */
  extraMints: (() => string[]) | null = null;
  /** Size of the de-duplicated candidate pool the last refresh considered (for the "N of M" header). */
  pool = 0;
  /** Live requests attempted through this feed's data layer (counted by the HTTP client). */
  requests = 0;
  /**
   * Mints the UI currently shows (task-1303): the interactive loop sets this to the on-screen rows so
   * the wide-pool fill enriches what the user can see FIRST (unpaced, fast), then trickles the rest.
   */
  visibleMints: (() => string[]) | null = null;
  /**
   * True while the wide-pool background fill is deliberately throttling DexScreener — either our own
   * soft budget (DS_TARGET_RPM) is holding it back, or the data layer paused the bucket after a 429 /
   * Retry-After. Drives the header's "slowing down" hint. Never set during the fast visible-first paint.
   */
  slowing = false;
  /** DexScreener calls the wide-pool fill issued in the trailing 60 s (reported in the handoff). */
  dsRate = 0;
  /**
   * Running count of DexScreener requests (both the fast tokens bucket and the slow boosts/profiles
   * bucket) the data layer has made, fed by `createLiveFeed`'s onRequest hook. The pacer differences
   * it per chunk so the budget counts real calls, not an estimate (cache hits cost nothing).
   */
  dsCalls = 0;
  private readonly pacer: DsPacer;
  /** True while the rows on screen are the restored snapshot and no fresh batch has landed yet (task-1323). */
  fromSnapshot = false;
  /** When the restored snapshot was written (epoch ms); null when the rows are fresh. */
  snapshotAt: number | null = null;
  /** Set when the boot fallback switched presets (task-1323): from which preset and why. */
  fellBack: { from: PresetId; reason: 'slow' | 'empty' } | null = null;
  /** Epoch ms when this run's first network rows landed (null until then); drives the boot trace. */
  firstFreshAt: number | null = null;
  readonly snapshot: boolean;
  readonly fastFirstPaint: boolean;
  readonly fallback: { preset: PresetId; afterMs: number } | null;
  /** Bumped by setPreset/close: a refresh started under an older generation stops writing rows. */
  private gen = 0;
  private lastSnapshotSave = 0;
  private fallbackArmed: boolean;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  /** Recording store when the feed was created with `record`; save() writes it. */
  recording: FixtureStore | null = null;
  /** The fixture store behind a replay feed (its `streams` carry recorded PumpPortal sessions). */
  replayStore: FixtureStore | null = null;

  readonly poolMax: number;
  /** Wide-pool discovery (task-1303); off for replays/recordings so fixtures stay identical. */
  readonly wide: boolean;

  /**
   * close() flips this so an in-flight refresh stops issuing work and the paced background sleep
   * resolves immediately (task-1303 defect #1): a quit during a paced wide-pool fill must let the
   * process exit at once, not hang for the rolling-window wait (which can approach 60 s).
   */
  private closed = false;
  /** The pending paced-fill sleep's timer + resolver, so close() can cancel/resolve it. */
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepResolve: (() => void) | null = null;

  constructor(dl: DataLayer, opts: FeedOptions = {}) {
    this.dl = dl;
    this.now = opts.now ?? (() => Date.now());
    this.limit = opts.limit ?? 30;
    this.poolMax = opts.poolMax ?? POOL_MAX;
    this.wide = opts.wide ?? false;
    if (opts.preset) this.preset = opts.preset;
    this.pacer = new DsPacer(opts.dsTargetRpm ?? DS_TARGET_RPM, this.now);
    this.snapshot = opts.snapshot ?? false;
    this.fastFirstPaint = opts.fastFirstPaint ?? false;
    this.fallback = opts.fallback ?? null;
    this.fallbackArmed = !!this.fallback;
    if (this.snapshot) this.restoreSnapshot();
  }

  /** Rows the screener would SHOW for the current preset (its baked filter applied; user filter aside). */
  shownCount(): number {
    const spec = presetSpec(this.preset) ?? PRESETS[0];
    return spec.baked ? applyFilter(this.rows, bakedFilter(spec)).length : this.rows.length;
  }

  /**
   * Restore the last persisted rows of the current preset (task-1323). Only into an empty feed; rows
   * come back flagged stale with their ages advanced by the time elapsed, `fromSnapshot` set until the
   * first fresh batch lands. Never throws: a missing/corrupt snapshot just means a cold paint.
   */
  restoreSnapshot(): boolean {
    if (!this.snapshot || this.rows.length) return false;
    try {
      const hit = this.dl.cache.get<FeedSnapshot>(SNAPSHOT_NS, this.preset);
      const snap = hit?.value;
      if (!hit || !snap || snap.v !== 1 || !Array.isArray(snap.rows)) return false;
      const elapsedMin = Math.max(0, (this.now() - hit.fetchedAt) / 60_000);
      const rows = snap.rows.filter((r) => r && typeof r.mint === 'string' && r.mint && typeof r.symbol === 'string')
        .map((r): ScreenerRow => ({ ...r, stale: true, ageMin: typeof r.ageMin === 'number' ? r.ageMin + elapsedMin : null }));
      if (!rows.length) return false;
      this.rows = rows;
      this.pool = Math.max(rows.length, snap.pool || 0);
      this.fromSnapshot = true;
      this.snapshotAt = hit.fetchedAt;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Persist the current rows for this preset (task-1323): what the user sees first (the visible rows),
   * then the rest, capped at SNAPSHOT_MAX_ROWS. Throttled to SNAPSHOT_SAVE_MS unless `force`. Rows that
   * are themselves a restored snapshot are never re-saved (that would refresh a stale snapshot's clock).
   */
  saveSnapshot(force = false): boolean {
    if (!this.snapshot || this.fromSnapshot || this.closed || this.rows.length === 0) return false;
    const now = this.now();
    if (!force && now - this.lastSnapshotSave < SNAPSHOT_SAVE_MS) return false;
    try {
      const vis = new Set(this.visibleMints ? this.visibleMints() : []);
      const ordered = [...this.rows.filter((r) => vis.has(r.mint)), ...this.rows.filter((r) => !vis.has(r.mint))];
      const rows = ordered.slice(0, SNAPSHOT_MAX_ROWS).map((r) => { const { fixture: _f, ...rest } = r; return rest as ScreenerRow; });
      const snap: FeedSnapshot = { v: 1, preset: this.preset, pool: this.pool, rows };
      this.dl.cache.set(SNAPSHOT_NS, this.preset, snap, { ttlMs: SNAPSHOT_TTL_MS, fetchedAt: now });
      this.lastSnapshotSave = now;
      return true;
    } catch {
      return false;
    }
  }

  /** Boot fallback check (task-1323): nothing on screen for the starting preset → switch to the fallback. */
  private maybeFallback(reason: 'slow' | 'empty'): void {
    const fb = this.fallback;
    if (!fb || this.closed || this.fellBack || this.preset === fb.preset) return;
    if (this.shownCount() > 0) return; // cached or fresh rows are on screen: never yank them away
    const from = this.preset;
    if (!this.setPreset(fb.preset)) return;
    this.fellBack = { from, reason };
    this.onProgress?.();
    void this.refresh();
  }

  private clearFallbackTimer(): void {
    if (this.fallbackTimer) { clearTimeout(this.fallbackTimer); this.fallbackTimer = null; }
  }

  presets(): PresetView[] {
    return presetViews(this.dl.health);
  }

  setPreset(id: PresetId): boolean {
    const v = this.presets().find((p) => p.id === id);
    if (!v || !v.available) return false;
    if (this.preset !== id) {
      this.saveSnapshot(true); // keep the preset we are leaving for an instant switch back
      this.preset = id; this.rows = []; this.refreshedAt = null; this.pool = 0;
      this.fromSnapshot = false; this.snapshotAt = null;
      // task-1323: orphan any in-flight refresh of the old preset (it stops writing rows at its next
      // checkpoint and its pace sleep is woken) so the new preset refreshes now, not after the old fill.
      this.gen++;
      this.refreshing = false;
      this.wakeSleep();
      this.restoreSnapshot();
    }
    return true;
  }

  /** Resolve a pending paced-fill sleep now (preset switch / close). */
  private wakeSleep(): void {
    if (this.sleepTimer) { clearTimeout(this.sleepTimer); this.sleepTimer = null; }
    if (this.sleepResolve) { const r = this.sleepResolve; this.sleepResolve = null; r(); }
  }

  /**
   * A cancellable, unref'd sleep for the paced background fill (task-1303 defect #1). Unref'd so a
   * pending pace wait never keeps the process alive on its own; close() clears the timer and resolves
   * it at once so a quit mid-fill exits immediately instead of waiting out the rolling window.
   */
  private sleep(ms: number): Promise<void> {
    if (this.closed || ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.sleepResolve = resolve;
      const t = setTimeout(() => { this.sleepTimer = null; this.sleepResolve = null; resolve(); }, ms);
      t.unref?.();
      this.sleepTimer = t;
    });
  }

  /**
   * Discover the preset's candidate mints (store caches lists 15 s) and enrich them into rows.
   * Two phases so the first rows paint fast and the pool then fills to hundreds (task-1303):
   *   1. the compact feed (one or two lists) → paint right away;
   *   2. the wide pool (toptrending/organic/traded across windows + boosts + profiles) → fill in
   *      enrichment-sized batches, painting each via `onProgress`.
   * Jupiter list calls return fully-enriched token records (seeded into the cache), so enrichment of
   * those mints is served from cache; DexScreener pair data is the only per-batch network cost.
   * Never throws: source errors land in `errors` and degrade rows instead of failing the refresh.
   */
  async refresh(): Promise<ScreenerRow[]> {
    if (this.refreshing) return this.rows;
    this.refreshing = true;
    const gen = this.gen;
    /** This refresh was orphaned (preset switched / feed closed): stop issuing work and writing rows. */
    const orphaned = (): boolean => this.closed || gen !== this.gen;
    // Boot fallback (task-1323): armed once, for the first refresh only.
    if (this.fallbackArmed && this.fallback) {
      this.fallbackArmed = false;
      const t = setTimeout(() => { this.fallbackTimer = null; this.maybeFallback('slow'); }, this.fallback.afterMs);
      t.unref?.();
      this.fallbackTimer = t;
    }
    // First-paint mode (task-1323): nothing fresh on screen yet (empty, or only the restored snapshot).
    const quick = this.fastFirstPaint && (this.rows.length === 0 || this.fromSnapshot);
    try {
      const spec = presetSpec(this.preset) ?? PRESETS[0];
      const errors: Partial<Record<SourceId, string>> = {};
      const seen = new Set<string>();
      const order: string[] = [];
      const rowByMint = new Map<string, ScreenerRow>();
      // Seed the render set from the rows already on screen (task-1303 defect #4). A refresh rebuilds
      // its pool in two phases; without this seed, phase 1 (the compact feed, ~100 mints) would
      // overwrite `this.rows` and the visible count would collapse to 100 on every cycle before the
      // wide pool refilled it. Carrying the current rows forward means rows only grow/update during a
      // refresh and stale mints are pruned once, at the end, after the pool is full again. (A restored
      // snapshot is seeded the same way: its rows are replaced as fresh data lands, pruned at the end.)
      for (const r of this.rows) { order.push(r.mint); rowByMint.set(r.mint, r); }
      // Monotonic baseline: every DexScreener call this refresh makes (discovery boosts/profiles AND
      // enrichment token batches) is recorded against the budget exactly once, when `recordDs` runs.
      let dsBaseline = this.dsCalls;
      const recordDs = (): void => { this.pacer.spent(this.dsCalls - dsBaseline); dsBaseline = this.dsCalls; this.dsRate = this.pacer.rate(); };
      /** Mints the quick first paint served DexScreener-only: re-enriched with Jupiter in phase 1b. */
      const needJup: string[] = [];

      // Enrich one chunk and fold the rows in. `pace` gates the chunk behind the soft DexScreener
      // budget BEFORE issuing it (background tail only). Either way the ACTUAL DexScreener calls the
      // chunk made — counted by the data layer's onRequest hook, so cached mints cost nothing — are
      // recorded against the budget, so the unpaced visible-first chunks still make the tail back off.
      const enrichBatch = async (batch: string[], pace: boolean, jupCacheOnly = false): Promise<void> => {
        // Fold any DexScreener calls made since the last record (discovery, or the previous chunk)
        // into the budget before deciding whether to wait, so the count is always current.
        recordDs();
        if (pace) {
          // One chunk is at most ceil(batch/30) DexScreener calls; wait if that would break the budget,
          // or if the data layer paused the bucket after a 429 / Retry-After.
          const cost = Math.ceil(batch.length / DS_TOKENS_BATCH);
          const paused = this.dl.limiter.bucket('dexscreener').stats().pausedUntil;
          const wait = Math.max(this.pacer.wait(cost), paused ? paused - this.now() : 0);
          if (wait > 0) { this.slowing = true; this.onProgress?.(); await this.sleep(wait); }
        }
        if (orphaned()) return; // a quit / preset switch during the pace wait: stop before issuing more calls
        // Wide pool skips the per-mint Jupiter price call (list + DexScreener already carry price) to
        // respect the shared 0.5 rps Jupiter bucket; the compact feed keeps it (and matches recordings).
        const res = await this.dl.store.enrich(batch, jupCacheOnly ? { price: false, jup: 'cache' } : { price: !this.wide });
        recordDs();
        if (orphaned()) return;
        this.slowing = this.dl.limiter.bucket('dexscreener').stats().pausedUntil > 0;
        Object.assign(errors, res.errors);
        const now = this.now();
        for (const r of res.rows) {
          if (!rowByMint.has(r.mint)) order.push(r.mint);
          rowByMint.set(r.mint, fromSnapshot(r, now));
          if (jupCacheOnly && !r.sources.includes('jupiter-tokens')) needJup.push(r.mint);
        }
        if (jupCacheOnly) needJup.push(...res.missing);
        this.rows = order.map((m) => rowByMint.get(m)!).filter(Boolean);
        this.errors = errors;
        this.refreshedAt = now;
        if (res.rows.length) this.landedFresh(now);
        this.onProgress?.();
      };

      const pending: string[] = [];
      const absorb = (mints: string[]): void => {
        for (const m of mints) if (!seen.has(m)) { seen.add(m); pending.push(m); }
        this.pool = Math.max(seen.size, this.fromSnapshot ? this.pool : 0);
      };
      /** Enrich everything collected so far. `pace` throttles the DexScreener calls (background fill). */
      const flush = async (pace: boolean, jupCacheOnly = false): Promise<void> => {
        while (pending.length) {
          if (orphaned()) return;
          const batch = pending.splice(0, ENRICH_CHUNK);
          await enrichBatch(batch, pace, jupCacheOnly);
        }
      };

      this.slowing = false;
      // Phase 1 — the compact feed, for a fast first paint (never paced).
      const feeds = spec.feeds as FeedPreset[];
      if (quick && feeds.length) {
        // Phase 1a (task-1323): ONE list, enriched DexScreener-only (Jupiter records come from the list
        // call's cache seed), then paint — the first screen never waits on the Jupiter bucket.
        const d = await this.dl.store.discover(feeds[0], this.limit);
        if (orphaned()) return this.rows;
        Object.assign(errors, d.errors);
        absorb(d.mints);
        await flush(false, true);
        if (orphaned()) return this.rows;
        // Phase 1b: the rows that painted without Jupiter fields get them now (one batched search).
        pending.push(...needJup.splice(0));
      }
      for (const feed of quick ? feeds.slice(1) : feeds) {
        const d = await this.dl.store.discover(feed, this.limit);
        if (orphaned()) return this.rows;
        Object.assign(errors, d.errors);
        absorb(d.mints);
      }
      await flush(false);
      if (orphaned()) return this.rows;

      // Phase 2 — the wide pool (live only). Discover the whole candidate net, then enrich
      // VISIBLE rows first (fast, unpaced) so what the user sees fills immediately, and trickle the
      // rest under the soft DexScreener budget so the pool cannot creep toward the shared rate cap.
      if (this.wide) {
        for (const feed of feeds) {
          const d = await this.dl.store.discover(feed, this.limit, { max: this.poolMax });
          if (orphaned()) return this.rows;
          Object.assign(errors, d.errors);
          absorb(d.mints);
        }
        // Phase 2a — fold the live PumpPortal new-pairs stream into the candidate pool for live-backed
        // presets. Brand-new mints with no pair yet degrade to dashes like any other row.
        if (this.extraMints && spec.live) absorb(this.extraMints().slice(0, this.poolMax));
        // Phase 2b — visible rows first (unpaced), then the long tail paced under the soft budget.
        // Reorder `pending` so on-screen mints lead; enrich that many unpaced, the remainder paced.
        const visible = new Set(this.visibleMints ? this.visibleMints() : []);
        const front = pending.filter((m) => visible.has(m));
        const back = pending.filter((m) => !visible.has(m));
        pending.length = 0;
        pending.push(...front, ...back);
        let remainingFront = front.length;
        while (pending.length) {
          if (orphaned()) break;
          const batch = pending.splice(0, Math.min(ENRICH_CHUNK, remainingFront > 0 ? remainingFront : ENRICH_CHUNK));
          const paced = remainingFront <= 0;
          remainingFront -= batch.length;
          await enrichBatch(batch, paced);
        }
      }
      if (orphaned()) return this.rows;

      // Prune rows that fell out of this refresh's candidate pool (task-1303 defect #4): done once,
      // now that the pool is full, so the visible count never dips mid-refresh. Skipped on an aborted
      // (closed) or empty-discovery refresh so a quit/transient miss cannot wipe the rows on screen.
      if (seen.size) {
        this.rows = order.filter((m) => seen.has(m)).map((m) => rowByMint.get(m)!).filter(Boolean);
        this.pool = seen.size;
        // A completed refresh replaced the snapshot wholesale (even if every list came back empty).
        if (this.fromSnapshot) { this.fromSnapshot = false; this.snapshotAt = null; }
      }
      this.errors = errors;
      this.refreshedAt = this.now();
      this.slowing = false;
      this.saveSnapshot();
      // Boot fallback (task-1323): the first refresh came back with nothing to show.
      if (this.fallback && !this.fellBack && this.fallbackTimer !== null) {
        this.clearFallbackTimer();
        if (this.shownCount() === 0) this.maybeFallback('empty');
      }
      return this.rows;
    } catch (err) {
      if (!orphaned()) this.errors = { ...this.errors, dexscreener: redactSecrets(err instanceof Error ? err.message : String(err)) };
      return this.rows;
    } finally {
      if (gen === this.gen) this.refreshing = false;
    }
  }

  /** The first network rows of this run landed (task-1323): drop the snapshot marker, persist, disarm. */
  private landedFresh(now: number): void {
    if (this.firstFreshAt === null) this.firstFreshAt = now;
    if (this.fromSnapshot) { this.fromSnapshot = false; this.snapshotAt = null; }
    if (this.shownCount() > 0) this.clearFallbackTimer();
    if (this.lastSnapshotSave === 0) this.saveSnapshot(true);
  }

  /** Column gates from the health registry (SPEC §3.5): columns whose only source is down render dim. */
  gates(): Record<string, Gate> {
    return gateAll(this.dl.health, COLUMN_SOURCES);
  }

  status(): FeedStatus {
    const h = this.dl.health;
    const used: SourceId[] = ['dexscreener', 'jupiter-tokens', 'jupiter-price'];
    const bad = used.filter((s) => { const st = h.state(s); return st === 'degraded' || st === 'probing'; });
    const names = [...new Set(bad.map((s) => SHORT[s] ?? s))];
    const label = [...new Set(used.filter((s) => h.isAvailable(s)).map((s) => SHORT[s] ?? s))].join(' · ') || 'no sources';
    // task-1323: restored rows say so until the first fresh batch replaces them.
    const cached = this.fromSnapshot && this.snapshotAt !== null ? `◌ cached ${agoLabel(this.now() - this.snapshotAt)} old · refreshing` : undefined;
    const fell = this.fellBack ? `◐ ${this.fellBack.from} ${this.fellBack.reason === 'slow' ? 'slow' : 'empty'} → ${this.preset}` : undefined;
    const degraded = names.length ? `◐ degraded: ${names.join(', ')}` : undefined;
    return { headerStatus: degraded ?? cached ?? fell, feedLabel: label, errors: this.errors };
  }

  refreshedAgo(): string {
    if (this.fromSnapshot && this.snapshotAt !== null) return agoLabel(this.now() - this.snapshotAt);
    if (this.refreshedAt === null) return this.refreshing ? '⌛' : '—';
    const s = Math.max(0, Math.round((this.now() - this.refreshedAt) / 1000));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
  }

  /** Write the recording (when created with `record`) in the data layer's fixture format. */
  save(path: string, note?: string): void {
    if (!this.recording) throw new Error('feed was not created with a recorder');
    this.recording.save(path, note ?? `recorded by trenchscope --record; ${this.requests} live requests; preset ${this.preset}`);
  }

  close(): void {
    // Abort any in-flight paced fill first (task-1303 defect #1): mark closed so refresh() bails, then
    // clear and resolve the pending pace sleep so the event loop is not held for the rolling window.
    // (No snapshot write here: quit must stay instant; refresh() persists at first paint + every 30 s.)
    this.closed = true;
    this.gen++;
    this.clearFallbackTimer();
    this.wakeSleep();
    this.dl.close();
  }
}

export interface LiveFeedOptions extends FeedOptions {
  dbPath?: string;
  /** Hard cap on live requests for this process (0 = unlimited). Exceeding it fails requests, which degrade the feed, never crash it. */
  maxRequests?: number;
  /** Keep every response so save() can write a replayable fixture file. */
  record?: boolean;
  onRequest?: DataLayerOptions['onRequest'];
  /** RPC endpoint (task-1298: Helius when the key is configured). Never logged; see resolveRpcUrl(). */
  rpcUrl?: string;
  rpcFallbackUrl?: string | null;
  /** Extra user-supplied free RPC endpoints (task-1309); never logged. */
  rpcExtraUrls?: string[];
  /** Add the keyless public RPC seed list to the pool (task-1309). */
  rpcPublicPool?: boolean;
  /** Helius credit meter: per-run hard cap in credits. */
  maxCredits?: number;
  /** Solana Tracker key (resolveTrackerKey); header-only, never logged. */
  trackerKey?: string | null;
  /**
   * Shrine key (resolveShrineKey); socket.io auth payload only, never logged. Ignored with `record`: a
   * recording captures HTTP only, so Shrine-served candles could not replay.
   */
  shrineKey?: string | null;
}

/**
 * Keyless live feed: public GET endpoints only, through the documented rate limits (the data
 * layer's limiter paces calls and honours Retry-After). pump.fun stays off until D-08 lands.
 */
export function createLiveFeed(opts: LiveFeedOptions = {}): ScreenerFeed {
  let store: FixtureStore | null = null;
  // task-1319 (AC1): the live transport the app actually runs must be aborted on quit. Build it with a
  // shutdown controller and hand the same controller to the data layer so feed.close() -> dl.close()
  // aborts THIS transport's in-flight fetch (the signal only reaches a caller-built transport this way).
  const shutdown = new AbortController();
  let transport: Transport = liveTransport({ shutdownSignal: shutdown.signal });
  if (opts.record || opts.maxRequests) {
    store = new FixtureStore();
    transport = recordingTransport(transport, store, { maxRequests: opts.maxRequests || Number.MAX_SAFE_INTEGER });
  }
  let feed: ScreenerFeed;
  const dl = createDataLayer({
    dbPath: opts.dbPath,
    transport,
    shutdownController: shutdown,
    disabled: ['pumpfun'],
    rpcUrl: opts.rpcUrl,
    rpcFallbackUrl: opts.rpcFallbackUrl,
    rpcExtraUrls: opts.rpcExtraUrls,
    rpcPublicPool: opts.rpcPublicPool,
    trackerKey: opts.trackerKey ?? null,
    shrineKey: opts.record ? null : opts.shrineKey ?? null,
    credits: opts.maxCredits ? { runCap: opts.maxCredits } : undefined,
    onRequest: (req, meta, o) => {
      feed.requests++;
      if (meta.bucket === 'dexscreener' || meta.bucket === 'dexscreener-slow') feed.dsCalls++;
      opts.onRequest?.(req, meta, o);
    },
  });
  // task-1311 (QA M4): the live app opens on the trench feed (fresh pump.fun + young memecoins,
  // blue chips / stocks / stables filtered out) unless the caller asked for a specific preset.
  // task-1323: paint the last cached feed instantly, first paint from one list, Trending fallback at 2.5 s.
  feed = new ScreenerFeed(dl, {
    ...opts, preset: opts.preset ?? 'trench', limit: opts.limit ?? PER_LIST, wide: true,
    snapshot: opts.snapshot ?? true, fastFirstPaint: opts.fastFirstPaint ?? true,
    fallback: opts.fallback === undefined ? { preset: 'trending', afterMs: FALLBACK_AFTER_MS } : opts.fallback,
  });
  // the recorder keeps every response (for --record) or just counts (for --max-requests)
  feed.recording = store;
  return feed;
}

/** Fixture clock from the recording so ages and the header clock are reproducible. */
export function fixtureRecordedAt(path: string): number {
  const file = JSON.parse(readFileSync(path, 'utf8')) as { recordedAt?: string };
  const t = Date.parse(file.recordedAt ?? '');
  return Number.isFinite(t) ? t : Date.now();
}

/** Rate buckets with nothing to be polite to (replays and tests). */
export function unlimitedBuckets(): typeof DEFAULT_BUCKETS {
  return Object.fromEntries(Object.entries(DEFAULT_BUCKETS).map(([k, v]) => [k, { ...v, rpm: 1e6, burst: 1e6 }]));
}

/**
 * Offline feed over a recorded fixture file (the data layer's recorder format). Same store, cache,
 * health registry and adapters as live; the transport is the replayer, so a miss throws instead of
 * touching the network. Rate buckets are widened: there is nothing to be polite to.
 */
export function createReplayFeed(path: string, opts: FeedOptions & { rpcUrl?: string } = {}): ScreenerFeed {
  const store = FixtureStore.load(path);
  const recordedAt = fixtureRecordedAt(path);
  // A recording made with a Helius key has `mainnet.helius-rpc.com/?api-key=REDACTED` entries: replay against that host.
  const heliusEntry = store.list().find((e) => e.url.includes('mainnet.helius-rpc.com'));
  const rpcUrl = opts.rpcUrl ?? (heliusEntry ? heliusEntry.url : undefined);
  const dl = createDataLayer({ transport: replayTransport(store), buckets: unlimitedBuckets(), disabled: ['pumpfun'], rpcUrl, rpcFallbackUrl: null });
  const feed = new ScreenerFeed(dl, { now: opts.now ?? (() => recordedAt + 2000), limit: opts.limit });
  feed.replayStore = store;
  return feed;
}
