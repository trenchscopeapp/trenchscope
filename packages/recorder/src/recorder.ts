// trenchscope history recorder (lane R-01, AI-SUITE-DESIGN §4.1). One class, four jobs:
//   observe   rows the data layer already normalised (Store listener) -> token_snapshots on change,
//             feed_members on entry / every few minutes. Zero requests.
//   sweep     re-observe mints that left the screen at the 1 h / 2 h / 6 h / 24 h / 72 h horizons: one
//             DexScreener token batch (30 mints) per call, queued at the limiter's LOWEST priority
//             ('low': never takes the reserve, always behind foreground work), capped per sweep and per
//             day, skipped while the bucket is paused after a 429. The only requests this package makes.
//   label     code-only outcome labels per (t0 anchor, horizon) from the recorded numbers (labels.ts).
//   prune     retention: raw JSON 7 d (focus rows only), one row per mint per minute after 24 h,
//             columns 90 d, outcomes/verdicts forever.
// Everything is synchronous SQLite on the app's own DB file (node:sqlite, WAL), batched in transactions,
// so a refresh never awaits the recorder and a crash loses at most one batch.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  withPriority, systemClock,
  type Clock, type DexScreener, type DiscoverEvent, type EnrichEvent, type EnrichedRow, type RateLimiter, type Store, type StoreListener,
} from '@dexterm/data';
import { ALL_HORIZONS_MASK, HORIZONS_SEC, SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts';
import { COLUMN_NAMES, fromDsView, fromEnrichedRow, isMaterialChange, type ChangeDetection, type Snapshot, type SnapshotColumns, type SnapshotKind } from './snapshot.ts';
import { LABELER_VERSION, labelAtHorizon, type Label, type Observation, type OutcomeRow } from './labels.ts';
import { dueBounds, selectDue, type DueMint, type MintSummary } from './sweep.ts';

export interface RecorderOptions {
  /** SQLite file (the app's `--db`); ':memory:' (default) for tests. */
  path?: string;
  clock?: Clock;
  /** Master switch: false = construct, record nothing, answer stats/export only. Default true. */
  enabled?: boolean;
  /** Mints whose rows keep the raw normalised JSON (watchlist + open token). Default: none. */
  focus?: () => Iterable<string>;
  /** Write an unchanged row anyway when the mint's last stored row is older than this (default 30 min). */
  heartbeatMs?: number;
  /** What counts as a change: 'material' buckets (default; see snapshot.ts) or the 'exact' record. */
  changeDetection?: ChangeDetection;
  /** New t0 anchor per mint at most this often (default 1 h). */
  t0EveryMs?: number;
  /** Full feed-membership write per feed at most this often (default 10 min); entrants are written at once. */
  membersEveryMs?: number;
  sweep?: Partial<SweepPolicy>;
  retention?: Partial<RetentionPolicy>;
  /** Diagnostic sink (--verbose). */
  onLog?: (line: string) => void;
}

export interface SweepPolicy {
  /** Minimum spacing between sweeps (default 60 s). */
  everyMs: number;
  /** DexScreener token-batch calls per sweep (default 6 = 180 mints, the design's budget line). */
  maxCallsPerSweep: number;
  /** Hard daily ceiling on sweep calls (default 1500 ≈ 1 per minute). */
  maxCallsPerDay: number;
  /** Mints per call (DexScreener tokens/v1 takes 30). */
  batch: number;
}

export interface RetentionPolicy {
  rawDays: number;
  columnsDays: number;
  downsampleAfterHours: number;
  /** Run the prune job at most this often (default 1 h). */
  everyMs: number;
}

export const DEFAULT_SWEEP: SweepPolicy = { everyMs: 60_000, maxCallsPerSweep: 6, maxCallsPerDay: 1500, batch: 30 };
export const DEFAULT_RETENTION: RetentionPolicy = { rawDays: 7, columnsDays: 90, downsampleAfterHours: 24, everyMs: 3_600_000 };
/** Unchanged rows are re-written this often at most; the horizons are ≥ 1 h, so 30 min keeps every window observed. */
export const DEFAULT_HEARTBEAT_MS = 1_800_000;
export const DEFAULT_T0_EVERY_MS = 3_600_000;
export const DEFAULT_MEMBERS_EVERY_MS = 600_000;
/** The labeler looks at open (unresolved, window not closed) horizons again after this long. */
export const LABEL_RETRY_MS = 300_000;
/** Label job: at most this many t0 rows per pass. */
export const LABEL_BATCH = 300;
/** In-memory last-row cache: entries not observed for this long are dropped (re-read from the DB on return). */
export const SEEN_EVICT_MS = 2 * 3_600_000;

export interface ObserveResult { written: number; skipped: number; heartbeat: number; t0: number }
export interface SweepResult { mints: number; calls: number; answered: number; skipped: 'disabled' | 'not-due' | 'paused' | 'in-flight' | 'day-cap' | null; error?: string }
export interface LabelResult { labelled: number; pending: number; counts: Partial<Record<Label, number>> }
export interface PruneResult { rawCleared: number; downsampled: number; expired: number; membersExpired: number }

export interface RecorderStats {
  enabled: boolean;
  schemaVersion: number;
  labelerVersion: string;
  snapshots: number;
  live: number;
  sweep: number;
  t0: number;
  withRaw: number;
  mints: number;
  feedMembers: number;
  outcomes: number;
  outcomesByLabel: Partial<Record<Label, number>>;
  sweeps: number;
  sweepCallsToday: number;
  /** Whole DB file (every table, the cache included), bytes. */
  dbBytes: number | null;
  /** Bytes used by the recorder's own tables and indexes (dbstat), null when dbstat is not compiled in. */
  recorderBytes: number | null;
  /** Mean stored bytes per snapshot row (dbstat when available, else an estimate from the row widths). */
  bytesPerSnapshot: number | null;
  oldestT: number | null;
  newestT: number | null;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface MintRow { mint: string; first_t: number; last_live_t: number; last_any_t: number; last_t0_t: number; last_hash: string; snapshots: number }

export class Recorder implements StoreListener {
  readonly enabled: boolean;
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private readonly focus: () => Iterable<string>;
  private readonly heartbeatMs: number;
  private readonly changeDetection: ChangeDetection;
  private readonly t0EveryMs: number;
  private readonly membersEveryMs: number;
  readonly sweepPolicy: SweepPolicy;
  readonly retention: RetentionPolicy;
  private readonly onLog?: (line: string) => void;
  /**
   * Per mint: the last WRITTEN row (columns + hash + time) and the newest observation time this process
   * saw, so unchanged rows cost no DB read. Seeded from the DB the first time a mint shows up in a run.
   */
  private readonly seen = new Map<string, { columns: SnapshotColumns; hash: string; t: number; writtenT: number; t0T: number }>();
  /** Per-feed membership already written: set of mints + time of the last full write. */
  private readonly members = new Map<string, { mints: Set<string>; fullAt: number }>();
  private lastSweepAt = 0;
  private lastLabelAt = 0;
  private lastPruneAt = 0;
  private sweeping = false;
  private closed = false;
  /** Counters for the handoff / --verbose. */
  readonly counters = { observed: 0, written: 0, heartbeat: 0, members: 0, sweepCalls: 0, labelled: 0 };
  private readonly stmts: {
    insertSnap: StatementSync; getMint: StatementSync; upsertMint: StatementSync; bumpAny: StatementSync;
    insertMember: StatementSync; lastIdentity: StatementSync; lastLive: StatementSync;
    insertCreator: StatementSync;
  };
  /** Mints whose creator link is already stored (this run), so a refresh costs no write. */
  private readonly creatorKnown = new Set<string>();

  constructor(opts: RecorderOptions = {}) {
    this.enabled = opts.enabled ?? true;
    this.path = opts.path ?? ':memory:';
    this.clock = opts.clock ?? systemClock;
    this.focus = opts.focus ?? (() => []);
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.changeDetection = opts.changeDetection ?? 'material';
    this.t0EveryMs = opts.t0EveryMs ?? DEFAULT_T0_EVERY_MS;
    this.membersEveryMs = opts.membersEveryMs ?? DEFAULT_MEMBERS_EVERY_MS;
    this.sweepPolicy = { ...DEFAULT_SWEEP, ...opts.sweep };
    this.retention = { ...DEFAULT_RETENTION, ...opts.retention };
    this.onLog = opts.onLog;
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA_SQL);
    this.db.prepare('INSERT OR REPLACE INTO recorder_meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    const cols = COLUMN_NAMES.join(', ');
    const marks = COLUMN_NAMES.map(() => '?').join(', ');
    this.stmts = {
      insertSnap: this.db.prepare(`INSERT INTO token_snapshots (t, kind, hash, is_t0, horizons_done, next_due_t, focus, sources, raw_json, ${cols}) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ${marks})`),
      getMint: this.db.prepare('SELECT mint, first_t, last_live_t, last_any_t, last_t0_t, last_hash, snapshots FROM mints WHERE mint = ?'),
      upsertMint: this.db.prepare(`INSERT INTO mints (mint, first_t, last_live_t, last_any_t, last_t0_t, last_hash, snapshots) VALUES (?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(mint) DO UPDATE SET last_live_t = excluded.last_live_t, last_any_t = MAX(last_any_t, excluded.last_any_t), last_t0_t = MAX(last_t0_t, excluded.last_t0_t), last_hash = excluded.last_hash, snapshots = snapshots + 1`),
      bumpAny: this.db.prepare('UPDATE mints SET last_any_t = MAX(last_any_t, ?), snapshots = snapshots + 1 WHERE mint = ?'),
      insertMember: this.db.prepare('INSERT OR IGNORE INTO feed_members (t, feed, rank, mint) VALUES (?, ?, ?, ?)'),
      lastIdentity: this.db.prepare('SELECT symbol, name, launchpad, created_at FROM token_snapshots WHERE mint = ? ORDER BY t DESC LIMIT 1'),
      lastLive: this.db.prepare(`SELECT t, hash, sources, ${cols} FROM token_snapshots WHERE mint = ? AND kind = 'live' ORDER BY t DESC LIMIT 1`),
      insertCreator: this.db.prepare('INSERT OR IGNORE INTO creators (mint, creator, source, first_t, created_at) VALUES (?, ?, ?, ?, ?)'),
    };
  }

  /** Attach as the data layer's store listener (and detach any previous one). */
  attach(store: Store): void {
    store.listener = this;
  }

  // ---------------------------------------------------------------- observe (StoreListener)

  onEnrich(ev: EnrichEvent): void {
    if (!this.enabled || this.closed) return;
    this.observe(ev.rows, this.clock.now());
  }

  onDiscover(ev: DiscoverEvent): void {
    if (!this.enabled || this.closed) return;
    const now = this.clock.now();
    for (const f of ev.feeds) this.recordMembers(f.name, f.mints, now);
  }

  /**
   * Record normalised rows. A row is written when it changed materially against the last row stored
   * for the mint (isMaterialChange; 'exact' mode: any change), when an hourly t0 anchor is due, or
   * (heartbeat) when the stored row is older than `heartbeatMs` so every horizon window holds an
   * observation. Rows whose fetchedAt did not move (served from cache) are skipped after one Map lookup.
   */
  observe(rows: readonly EnrichedRow[], now = this.clock.now()): ObserveResult {
    const res: ObserveResult = { written: 0, skipped: 0, heartbeat: 0, t0: 0 };
    if (!this.enabled || this.closed || rows.length === 0) return res;
    const focus = new Set(this.focus());
    const pending: { snap: Snapshot; focus: boolean }[] = [];
    for (const r of rows) {
      this.counters.observed++;
      // 0.1.5 dev history: the creator the row's source names (Jupiter `dev`), stored once per mint.
      const dev = r.audit?.devAddress;
      if (r.mint && dev) this.recordCreator(r.mint, dev, r.audit?.source ?? 'jupiter-tokens', now, r.token?.createdAt ?? null);
      if (!r.mint || !r.pair) { res.skipped++; continue; }
      const snap = fromEnrichedRow(r);
      const t = snap.t || now;
      let prev = this.seen.get(r.mint);
      if (prev && t <= prev.t) { res.skipped++; continue; }           // same fetch as last time: nothing new
      if (!prev) {
        const last = this.lastStored(r.mint);
        if (last) {
          const m = this.stmts.getMint.get(r.mint) as MintRow | undefined;
          prev = { ...last, t: 0, t0T: m?.last_t0_t ?? 0 };
          this.seen.set(r.mint, prev);
        }
      }
      const unchanged = prev ? (this.changeDetection === 'exact' ? prev.hash === snap.hash : !isMaterialChange(prev.columns, snap.columns)) : false;
      if (prev && unchanged && t - prev.writtenT < this.heartbeatMs && t - prev.t0T < this.t0EveryMs) {
        prev.t = t;
        res.skipped++;
        continue;
      }
      if (unchanged) res.heartbeat++;
      snap.t = t;
      pending.push({ snap, focus: focus.has(r.mint) });
      this.seen.set(r.mint, { columns: snap.columns, hash: snap.hash, t, writtenT: t, t0T: prev?.t0T ?? 0 });
    }
    if (!pending.length) return res;
    this.db.exec('BEGIN');
    try {
      for (const p of pending) {
        const isT0 = this.writeSnapshot(p.snap, 'live', p.focus);
        res.written++;
        if (isT0) { res.t0++; this.seen.get(p.snap.columns.mint)!.t0T = p.snap.t; }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.counters.written += res.written;
    this.counters.heartbeat += res.heartbeat;
    return res;
  }

  /**
   * Record which wallet created `mint`, as `source` named it (0.1.5 dev history). First writer wins; a mint or
   * creator that is not a base58 address is ignored. Returns true when a new link was stored.
   */
  recordCreator(mint: string, creator: string, source: string, now = this.clock.now(), createdAt: number | null = null): boolean {
    if (!this.enabled || this.closed || this.creatorKnown.has(mint)) return false;
    if (!BASE58.test(mint) || !BASE58.test(creator) || mint === creator) return false;
    this.creatorKnown.add(mint);
    if (this.creatorKnown.size > 200_000) this.creatorKnown.clear();
    const r = this.stmts.insertCreator.run(mint, creator, String(source).slice(0, 24), now, createdAt !== null && Number.isFinite(createdAt) ? Math.round(createdAt) : null);
    return Number(r.changes) > 0;
  }

  /** The mint's last stored live row (one indexed read; only paid the first time a mint is seen this run). */
  private lastStored(mint: string): { columns: SnapshotColumns; hash: string; writtenT: number } | null {
    const row = this.stmts.lastLive.get(mint) as (Record<string, string | number | null> & { hash: string; t: number; sources: string }) | undefined;
    if (!row) return null;
    const columns = {} as Record<string, unknown>;
    for (const k of COLUMN_NAMES) columns[k] = row[k] ?? null;
    let sources: string[] = [];
    try { sources = JSON.parse(row.sources) as string[]; } catch { sources = []; }
    columns.sources = sources;
    return { columns: columns as unknown as SnapshotColumns, hash: row.hash, writtenT: Number(row.t) };
  }

  /** Insert one row (inside the caller's transaction); returns true when it became a t0 anchor. */
  private writeSnapshot(snap: Snapshot, kind: SnapshotKind, focus: boolean): boolean {
    const c = snap.columns;
    const m = this.stmts.getMint.get(c.mint) as MintRow | undefined;
    const isT0 = kind === 'live' && (!m || snap.t - m.last_t0_t >= this.t0EveryMs);
    const nextDue = isT0 ? snap.t + HORIZONS_SEC[0] * 1000 : 0;
    const values = COLUMN_NAMES.map((k) => c[k] as string | number | null);
    this.stmts.insertSnap.run(snap.t, kind, snap.hash, isT0 ? 1 : 0, nextDue, focus ? 1 : 0, JSON.stringify(c.sources), focus ? JSON.stringify(snap.raw) : null, ...values);
    if (kind === 'live') this.stmts.upsertMint.run(c.mint, snap.t, snap.t, snap.t, isT0 ? snap.t : 0, snap.hash);
    else if (m) this.stmts.bumpAny.run(snap.t, c.mint);
    else this.stmts.upsertMint.run(c.mint, snap.t, 0, snap.t, 0, snap.hash);
    return isT0;
  }

  /**
   * Feed membership: entrants (mints not in the feed's last written list) are written at once with their
   * rank; the whole list is rewritten every `membersEveryMs` so ranks have a time series without a row
   * per mint per refresh (10 sub-feeds x 100 rows x 6/min would be 8.6 M rows a day).
   */
  recordMembers(feed: string, mints: readonly string[], now = this.clock.now()): number {
    if (!this.enabled || this.closed) return 0;
    const prev = this.members.get(feed);
    const full = !prev || now - prev.fullAt >= this.membersEveryMs;
    let n = 0;
    this.db.exec('BEGIN');
    try {
      mints.forEach((mint, rank) => {
        if (full || !prev!.mints.has(mint)) { this.stmts.insertMember.run(now, feed, rank, mint); n++; }
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.members.set(feed, { mints: new Set(mints), fullAt: full ? now : prev!.fullAt });
    this.counters.members += n;
    return n;
  }

  // ---------------------------------------------------------------- maintenance (sweep + label + prune)

  /**
   * The app calls this from its tick (every 60 s is plenty). Runs whichever job is due; never throws
   * (errors are logged and counted). Sweeps are the only network activity and go through `deps`.
   */
  async maintain(deps: { dexscreener: DexScreener; limiter: RateLimiter }, now = this.clock.now()): Promise<{ sweep: SweepResult | null; labels: LabelResult | null; prune: PruneResult | null }> {
    const out: { sweep: SweepResult | null; labels: LabelResult | null; prune: PruneResult | null } = { sweep: null, labels: null, prune: null };
    if (!this.enabled || this.closed) return out;
    // Memory: forget mints not observed for a while (re-seeded from the DB when they come back), so a
    // day-long session over thousands of churned mints does not keep every last row on the heap.
    for (const [mint, s] of this.seen) if (now - s.t > SEEN_EVICT_MS) this.seen.delete(mint);
    try {
      if (now - this.lastSweepAt >= this.sweepPolicy.everyMs) out.sweep = await this.sweep(deps, now);
    } catch (err) { this.log(`sweep failed: ${msg(err)}`); }
    try {
      if (now - this.lastLabelAt >= this.sweepPolicy.everyMs) { this.lastLabelAt = now; out.labels = this.labelPending(now); }
    } catch (err) { this.log(`label failed: ${msg(err)}`); }
    try {
      if (now - this.lastPruneAt >= this.retention.everyMs) { this.lastPruneAt = now; out.prune = this.prune(now); }
    } catch (err) { this.log(`prune failed: ${msg(err)}`); }
    return out;
  }

  /** Mints whose horizon window is open and unobserved (sweep.ts), soonest-closing first. */
  due(now = this.clock.now(), max = this.sweepPolicy.maxCallsPerSweep * this.sweepPolicy.batch): DueMint[] {
    const b = dueBounds(now);
    const rows = this.db.prepare('SELECT mint, last_live_t, last_any_t FROM mints WHERE last_live_t >= ? AND last_live_t <= ? AND last_live_t > 0').all(b.from, b.to) as unknown as MintSummary[];
    return selectDue(rows, now, max);
  }

  /** Sweep calls issued in the current UTC day (from the sweeps ledger). */
  sweepCallsToday(now = this.clock.now()): number {
    const day = new Date(now).toISOString().slice(0, 10);
    const start = Date.parse(`${day}T00:00:00Z`);
    const r = this.db.prepare('SELECT COALESCE(SUM(calls), 0) AS n FROM sweeps WHERE started_at >= ?').get(start) as { n: number };
    return Number(r.n);
  }

  /**
   * One outcome sweep: the due mints, `batch` per DexScreener call, at most `maxCallsPerSweep` calls,
   * each issued at 'low' priority inside the data layer's own limiter and health gate (a paused bucket
   * after a 429 or a down source means the sweep waits for the next tick). Every answered mint gets a
   * `kind = 'sweep'` row; a mint DexScreener did not answer for gets a `src_market = 'none'` row
   * (pair vanished / never had a pool), which the labeler treats as the prototype did.
   */
  async sweep(deps: { dexscreener: DexScreener; limiter: RateLimiter }, now = this.clock.now()): Promise<SweepResult> {
    const none = (skipped: SweepResult['skipped']): SweepResult => ({ mints: 0, calls: 0, answered: 0, skipped });
    if (!this.enabled || this.closed) return none('disabled');
    if (this.sweeping) return none('in-flight');
    const paused = deps.limiter.bucket('dexscreener').stats().pausedUntil;
    if (paused > now) return none('paused');
    const todays = this.sweepCallsToday(now);
    const budget = Math.min(this.sweepPolicy.maxCallsPerSweep, this.sweepPolicy.maxCallsPerDay - todays);
    if (budget <= 0) return none('day-cap');
    const due = this.due(now, budget * this.sweepPolicy.batch);
    this.lastSweepAt = now;
    if (!due.length) return none('not-due');
    this.sweeping = true;
    const started = now;
    const ins = this.db.prepare('INSERT INTO sweeps (started_at, mints, calls) VALUES (?, ?, 0)').run(started, due.length);
    const sweepId = Number(ins.lastInsertRowid);
    let calls = 0;
    let answered = 0;
    let error: string | undefined;
    try {
      for (let i = 0; i < due.length; i += this.sweepPolicy.batch) {
        const chunk = due.slice(i, i + this.sweepPolicy.batch).map((d) => d.mint);
        calls++;
        // no dead-pair rechecks here: the sweep has a hard per-call budget (maxCallsPerSweep / maxCallsPerDay)
        const views = await withPriority('low', () => deps.dexscreener.tokens(chunk, { recheckDead: false }));
        const t = this.clock.now();
        this.db.exec('BEGIN');
        try {
          for (const mint of chunk) {
            const v = views.get(mint);
            if (v) answered++;
            const base = this.stmts.lastIdentity.get(mint) as { symbol: string | null; name: string | null; launchpad: string | null; created_at: number | null } | undefined;
            this.writeSnapshot(fromDsView(mint, v, base, t), 'sweep', false);
          }
          this.db.exec('COMMIT');
        } catch (err) { this.db.exec('ROLLBACK'); throw err; }
        this.db.prepare('UPDATE sweeps SET calls = ?, answered = ? WHERE sweep_id = ?').run(calls, answered, sweepId);
        if (this.closed) break;
      }
    } catch (err) {
      error = msg(err);
    } finally {
      this.sweeping = false;
      this.db.prepare('UPDATE sweeps SET finished_at = ?, calls = ?, answered = ?, error = ? WHERE sweep_id = ?').run(this.clock.now(), calls, answered, error ?? null, sweepId);
      this.counters.sweepCalls += calls;
    }
    this.log(`sweep: ${due.length} mints, ${calls} calls, ${answered} answered${error ? `, error ${error}` : ''}`);
    return { mints: due.length, calls, answered, skipped: null, ...(error ? { error } : {}) };
  }

  // ---------------------------------------------------------------- labels

  /**
   * Label every t0 anchor whose next horizon is due. For (t0, h): t1 = the first observation at or
   * after t0 + h within t0 + 2h; none yet and the window still open → look again in LABEL_RETRY_MS;
   * none and the window closed → `unobserved`. max_mcap_ratio uses every observation in (t0, t1].
   */
  labelPending(now = this.clock.now(), max = LABEL_BATCH): LabelResult {
    const res: LabelResult = { labelled: 0, pending: 0, counts: {} };
    if (!this.enabled || this.closed) return res;
    const t0s = this.db.prepare(`SELECT snap_id, mint, t, horizons_done, mcap, liquidity_usd, price_usd, vol_h1, pair_address, src_market, launchpad
      FROM token_snapshots WHERE is_t0 = 1 AND horizons_done < ${ALL_HORIZONS_MASK} AND next_due_t <= ? ORDER BY next_due_t LIMIT ?`).all(now, max) as unknown as (Observation & { snap_id: number; horizons_done: number })[];
    if (!t0s.length) return res;
    const obsStmt = this.db.prepare('SELECT mint, t, mcap, liquidity_usd, price_usd, vol_h1, pair_address, src_market, launchpad FROM token_snapshots WHERE mint = ? AND t > ? AND t <= ? ORDER BY t');
    const insOutcome = this.db.prepare('INSERT OR REPLACE INTO outcomes (mint, t0, horizon_sec, t1, label, label_tier, mcap_ratio, liq_ratio, price_ratio, max_mcap_ratio, evidence, labeler_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const upd = this.db.prepare('UPDATE token_snapshots SET horizons_done = ?, next_due_t = ? WHERE snap_id = ?');
    this.db.exec('BEGIN');
    try {
      for (const t0 of t0s) {
        let done = t0.horizons_done;
        let nextDue = Number.POSITIVE_INFINITY;
        // One read for the widest pending window; slice per horizon in memory.
        const maxH = Math.max(...HORIZONS_SEC.filter((_, i) => !(done & (1 << i))));
        const obs = obsStmt.all(t0.mint, t0.t, t0.t + 2 * maxH * 1000) as unknown as Observation[];
        HORIZONS_SEC.forEach((h, i) => {
          const bit = 1 << i;
          if (done & bit) return;
          const open = t0.t + h * 1000;
          const close = t0.t + 2 * h * 1000;
          if (now < open) { nextDue = Math.min(nextDue, open); return; }
          const idx = obs.findIndex((o) => o.t >= open && o.t <= close);
          let row: OutcomeRow;
          if (idx >= 0) row = labelAtHorizon(t0, obs.slice(0, idx + 1), h);
          else if (now > close) row = labelAtHorizon(t0, [], h);
          else { nextDue = Math.min(nextDue, now + LABEL_RETRY_MS); return; }
          insOutcome.run(row.mint, row.t0, row.horizon_sec, row.t1, row.label, row.label_tier, row.mcap_ratio, row.liq_ratio, row.price_ratio, row.max_mcap_ratio, row.evidence, row.labeler_version);
          done |= bit;
          res.labelled++;
          res.counts[row.label] = (res.counts[row.label] ?? 0) + 1;
        });
        if (done !== t0.horizons_done || Number.isFinite(nextDue)) upd.run(done, done === ALL_HORIZONS_MASK ? 0 : Number.isFinite(nextDue) ? nextDue : now + LABEL_RETRY_MS, t0.snap_id);
        if (done !== ALL_HORIZONS_MASK) res.pending++;
      }
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
    this.counters.labelled += res.labelled;
    if (res.labelled) this.log(`labels: ${res.labelled} written (${Object.entries(res.counts).map(([k, v]) => `${k} ${v}`).join(', ')}), ${res.pending} t0 rows still open`);
    return res;
  }

  // ---------------------------------------------------------------- retention

  /**
   * Retention (design §4.1): raw JSON after `rawDays`; after `downsampleAfterHours` keep one live row per
   * mint per minute (the first), never a t0 anchor or a row an outcome cites as t1; everything older
   * than `columnsDays` goes (outcomes and verdicts stay forever). Downsampling is incremental: a
   * watermark in recorder_meta means each pass only looks at the hours that newly crossed the line.
   */
  prune(now = this.clock.now()): PruneResult {
    const res: PruneResult = { rawCleared: 0, downsampled: 0, expired: 0, membersExpired: 0 };
    if (this.closed) return res;
    const day = 86_400_000;
    const rawBefore = now - this.retention.rawDays * day;
    const colsBefore = now - this.retention.columnsDays * day;
    const dsBefore = now - this.retention.downsampleAfterHours * 3_600_000;
    const wm = this.db.prepare("SELECT value FROM recorder_meta WHERE key = 'downsampled_until'").get() as { value: string } | undefined;
    const from = Math.max(wm ? Number(wm.value) : 0, colsBefore);
    this.db.exec('BEGIN');
    try {
      res.rawCleared = Number(this.db.prepare('UPDATE token_snapshots SET raw_json = NULL WHERE raw_json IS NOT NULL AND t < ?').run(rawBefore).changes);
      if (dsBefore > from) {
        res.downsampled = Number(this.db.prepare(`DELETE FROM token_snapshots WHERE snap_id IN (
            SELECT s.snap_id FROM token_snapshots s
            WHERE s.t >= ? AND s.t < ? AND s.is_t0 = 0 AND s.kind = 'live'
              AND s.snap_id > (SELECT MIN(m.snap_id) FROM token_snapshots m WHERE m.mint = s.mint AND m.t >= (s.t / 60000) * 60000 AND m.t < (s.t / 60000) * 60000 + 60000)
              AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.mint = s.mint AND o.t1 = s.t)
          )`).run(from, dsBefore).changes);
        this.db.prepare("INSERT OR REPLACE INTO recorder_meta (key, value) VALUES ('downsampled_until', ?)").run(String(dsBefore));
      }
      res.expired = Number(this.db.prepare('DELETE FROM token_snapshots WHERE t < ?').run(colsBefore).changes);
      res.membersExpired = Number(this.db.prepare('DELETE FROM feed_members WHERE t < ?').run(colsBefore).changes);
      this.db.prepare('DELETE FROM mints WHERE last_any_t < ?').run(colsBefore);
      this.db.prepare('DELETE FROM sweeps WHERE started_at < ?').run(colsBefore);
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
    if (res.rawCleared || res.downsampled || res.expired) this.log(`prune: raw ${res.rawCleared}, downsampled ${res.downsampled}, expired ${res.expired} rows`);
    return res;
  }

  // ---------------------------------------------------------------- read side

  stats(now = this.clock.now()): RecorderStats {
    const one = <T>(sql: string, ...args: (string | number)[]): T => this.db.prepare(sql).get(...args) as T;
    const s = one<{ n: number; live: number; sweep: number; t0: number; raw: number; oldest: number | null; newest: number | null }>(
      "SELECT COUNT(*) AS n, SUM(kind = 'live') AS live, SUM(kind = 'sweep') AS sweep, SUM(is_t0) AS t0, SUM(raw_json IS NOT NULL) AS raw, MIN(t) AS oldest, MAX(t) AS newest FROM token_snapshots",
    );
    const byLabel: Partial<Record<Label, number>> = {};
    for (const r of this.db.prepare('SELECT label, COUNT(*) AS n FROM outcomes GROUP BY label').all() as { label: Label; n: number }[]) byLabel[r.label] = Number(r.n);
    let dbBytes: number | null = null;
    try {
      const pc = one<{ page_count: number }>('PRAGMA page_count').page_count;
      const ps = one<{ page_size: number }>('PRAGMA page_size').page_size;
      dbBytes = Number(pc) * Number(ps);
    } catch { dbBytes = null; }
    let bytesPerSnapshot: number | null = null;
    let recorderBytes: number | null = null;
    try {
      const d = one<{ b: number | null }>("SELECT SUM(pgsize) AS b FROM dbstat WHERE name IN ('token_snapshots', 'token_snapshots_mint_t', 'token_snapshots_t', 'token_snapshots_t0_pending')");
      if (d.b !== null && Number(s.n) > 0) bytesPerSnapshot = Number(d.b) / Number(s.n);
      const all = one<{ b: number | null }>("SELECT SUM(pgsize) AS b FROM dbstat WHERE name IN ('recorder_meta', 'feed_members', 'feed_members_mint_t', 'token_snapshots', 'token_snapshots_mint_t', 'token_snapshots_t', 'token_snapshots_t0_pending', 'mints', 'mints_last_live', 'sweeps', 'chain_events', 'chain_events_mint_t', 'outcomes', 'outcomes_label', 'verdicts', 'verdicts_mint_t')");
      recorderBytes = all.b === null ? null : Number(all.b);
    } catch {
      // dbstat not compiled in: estimate from the stored widths (rows + the three indexes).
      if (Number(s.n) > 0) {
        const w = one<{ w: number }>("SELECT AVG(LENGTH(COALESCE(symbol,'')) + LENGTH(COALESCE(name,'')) + LENGTH(COALESCE(pair_address,'')) + LENGTH(COALESCE(raw_json,'')) + LENGTH(sources) + 44 + 8 * 48) AS w FROM token_snapshots").w;
        bytesPerSnapshot = Number(w) + 2 * 60;
      }
    }
    return {
      enabled: this.enabled,
      schemaVersion: SCHEMA_VERSION,
      labelerVersion: LABELER_VERSION,
      snapshots: Number(s.n), live: Number(s.live ?? 0), sweep: Number(s.sweep ?? 0), t0: Number(s.t0 ?? 0), withRaw: Number(s.raw ?? 0),
      mints: Number(one<{ n: number }>('SELECT COUNT(*) AS n FROM mints').n),
      feedMembers: Number(one<{ n: number }>('SELECT COUNT(*) AS n FROM feed_members').n),
      outcomes: Number(one<{ n: number }>('SELECT COUNT(*) AS n FROM outcomes').n),
      outcomesByLabel: byLabel,
      sweeps: Number(one<{ n: number }>('SELECT COUNT(*) AS n FROM sweeps').n),
      sweepCallsToday: this.sweepCallsToday(now),
      dbBytes, recorderBytes, bytesPerSnapshot,
      oldestT: s.oldest === null ? null : Number(s.oldest),
      newestT: s.newest === null ? null : Number(s.newest),
    };
  }

  /** Raw access for the export / backtest readers (read-only use). */
  get database(): DatabaseSync {
    return this.db;
  }

  /** Mints currently held in the in-memory last-row cache (diagnostics / tests). */
  get cachedMints(): number {
    return this.seen.size;
  }

  /**
   * Close the DB. First (task-1361) label whatever t0 anchors are due: code only, one bounded synchronous
   * pass, so a run shorter than the first maintenance tick still leaves its outcomes behind instead of
   * nothing. Never throws; a failure is logged and the DB still closes.
   */
  close(): { labelled: number } {
    if (this.closed) return { labelled: 0 };
    let labelled = 0;
    if (this.enabled) {
      try { labelled = this.labelPending(this.clock.now()).labelled; } catch (err) { this.log(`labels at close failed: ${msg(err)}`); }
    }
    this.closed = true;
    this.db.close();
    return { labelled };
  }

  private log(line: string): void {
    this.onLog?.(`recorder: ${line}\n`);
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
