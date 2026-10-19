// task-1323 item 1: the first paint is never an empty list. (a) the last rendered rows per preset are
// persisted in the SQLite cache and restored before the first fetch (stale until refreshed); (b) with
// nothing cached the screener shows skeleton rows while the first fetch lands; (c) the default feed
// falls back to Trending when it shows nothing within the budget or comes back empty. Plus the fast
// first paint (one list, DexScreener-only, no queued Jupiter call) and preset-switch orphaning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cache, HealthRegistry, type DataLayer, type EnrichedRow } from '@dexterm/data';
import { ScreenerFeed, SNAPSHOT_NS, SNAPSHOT_MAX_ROWS } from '../src/feed.ts';
import { makeScreenerState, screenerView, showsSkeleton } from '../src/screener/view.ts';
import type { ScreenerRow } from '../src/screener/rows.ts';
import { makeFixtureState } from '../src/state.ts';
import { applyAction } from '../src/main.ts';

function row(mint: string, o: { liq?: number; verified?: boolean; sources?: string[]; created?: number } = {}): EnrichedRow {
  return {
    mint,
    token: { mint, symbol: mint.toUpperCase().slice(0, 8), name: mint, launchpad: 'pump.fun', verified: o.verified ?? false, sus: false, fetchedAt: 0, socials: {}, createdAt: o.created },
    pair: {
      pairAddress: `p-${mint}`, priceUsd: 1, fdv: 1, mcap: 1, liquidityUsd: o.liq ?? 10_000,
      priceChange: { m5: null, h1: null, h6: null, h24: null },
      volume: { h24: 0, h6: 0, h1: 0, m5: 0 }, txns: {}, fetchedAt: 0,
    },
    stats: null, audit: null, price: null, mcap: null, sparkline: undefined, sources: o.sources ?? ['dexscreener'], stale: false,
  } as unknown as EnrichedRow;
}

interface Stub { dl: DataLayer; cache: Cache; calls: string[]; dir: string; done(): void }

/** A stub data layer over a REAL SQLite cache file (the snapshot lives there) and a scripted store. */
function stub(store: { discover: (feed: string, limit: number, opts?: { max?: number }) => Promise<{ mints: string[]; errors: Record<string, string> }>; enrich: (batch: string[], opts?: { price?: boolean; jup?: string }) => Promise<{ rows: EnrichedRow[]; missing?: string[]; errors: Record<string, string> }> }, now: () => number, dir?: string): Stub {
  const d = dir ?? mkdtempSync(join(tmpdir(), 'dexterm-1323-feed-'));
  const cache = new Cache({ path: join(d, 'cache.db'), clock: { now, sleep: async () => {} } });
  const calls: string[] = [];
  const dl = {
    store: {
      discover: (f: string, l: number, o?: { max?: number }) => { calls.push(`discover ${f}${o?.max ? ' wide' : ''}`); return store.discover(f, l, o); },
      enrich: async (b: string[], o?: { price?: boolean; jup?: string }) => { calls.push(`enrich ${b.join(',')}${o?.jup === 'cache' ? ' jup:cache' : ''}`); const r = await store.enrich(b, o); return { missing: [], ...r }; },
    },
    limiter: { bucket: () => ({ stats: () => ({ pausedUntil: 0 }) }) },
    health: new HealthRegistry(),
    cache,
    close() {},
  } as unknown as DataLayer;
  return { dl, cache, calls, dir: d, done: () => { cache.close(); if (!dir) rmSync(d, { recursive: true, force: true }); } };
}

const lists = (m: Record<string, string[]>) => async (f: string) => ({ mints: m[f] ?? [], errors: {} });
const enrichAll = async (b: string[]) => ({ rows: b.map((m) => row(m)), errors: {} });

test('(a) the last rendered rows are restored from SQLite before any fetch, stale and aged, then replaced', async () => {
  let now = 1_700_000_000_000;
  const a = stub({ discover: lists({ trending: ['m1', 'm2', 'm3'] }), enrich: async (b) => ({ rows: b.map((m) => row(m, { created: now - 10 * 60_000 })), errors: {} }) }, () => now);
  const f1 = new ScreenerFeed(a.dl, { preset: 'trending', snapshot: true, fastFirstPaint: true, now: () => now });
  assert.equal(f1.rows.length, 0, 'nothing cached on the very first launch');
  await f1.refresh();
  assert.deepEqual(f1.rows.map((r) => r.mint), ['m1', 'm2', 'm3']);
  const saved = a.cache.get<{ rows: unknown[] }>(SNAPSHOT_NS, 'trending');
  assert.ok(saved && saved.value.rows.length === 3, 'the first fresh paint persisted the rows');
  const age1 = f1.rows[0].ageMin!;
  a.cache.close();

  // Next launch, 5 minutes later: a NEW feed over the same DB shows the rows at construction time.
  now += 5 * 60_000;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const b = stub({
    discover: async (f) => { await gate; return { mints: f === 'trending' ? ['m2', 'm4'] : [], errors: {} }; },
    enrich: async (bt) => ({ rows: bt.map((m) => row(m)), errors: {} }),
  }, () => now, a.dir);
  const f2 = new ScreenerFeed(b.dl, { preset: 'trending', snapshot: true, fastFirstPaint: true, now: () => now });
  assert.deepEqual(f2.rows.map((r) => r.mint), ['m1', 'm2', 'm3'], 'cached rows are on screen before the first fetch');
  assert.equal(f2.fromSnapshot, true);
  assert.ok(f2.rows.every((r) => r.stale), 'restored rows are marked stale');
  assert.ok(Math.abs(f2.rows[0].ageMin! - (age1 + 5)) < 0.01, 'ages advanced by the time since the snapshot');
  assert.match(f2.status().headerStatus ?? '', /cached 5m old · refreshing/);
  assert.equal(f2.refreshedAgo(), '5m', 'the header age is the snapshot age, not "just now"');
  assert.equal(b.calls.length, 0, 'no request was needed to paint them');

  const p = f2.refresh();
  release();
  await p;
  assert.equal(f2.fromSnapshot, false, 'fresh rows replaced the snapshot');
  assert.deepEqual(f2.rows.map((r) => r.mint).sort(), ['m2', 'm4'], 'snapshot rows no longer in the feed were pruned');
  assert.ok(f2.rows.every((r) => !r.stale));
  assert.equal(f2.status().headerStatus, undefined);
  b.done();
  rmSync(a.dir, { recursive: true, force: true });
});

test('(a) snapshot: capped, visible rows first, never re-saved from a restored snapshot, corrupt = cold', () => {
  const now = 1_700_000_000_000;
  const s = stub({ discover: lists({}), enrich: enrichAll }, () => now);
  const f = new ScreenerFeed(s.dl, { preset: 'trending', snapshot: true, now: () => now });
  f.rows = Array.from({ length: SNAPSHOT_MAX_ROWS + 50 }, (_, i) => ({ ...rowView(`m${i}`) }));
  f.visibleMints = () => ['m240', 'm241'];
  assert.equal(f.saveSnapshot(true), true);
  const snap = s.cache.get<{ rows: { mint: string }[] }>(SNAPSHOT_NS, 'trending')!.value;
  assert.equal(snap.rows.length, SNAPSHOT_MAX_ROWS);
  assert.deepEqual(snap.rows.slice(0, 2).map((r) => r.mint), ['m240', 'm241'], 'what the user saw is kept first');
  f.fromSnapshot = true;
  assert.equal(f.saveSnapshot(true), false, 'a restored snapshot is never written back (its clock would lie)');
  s.cache.set(SNAPSHOT_NS, 'organic', { v: 1, rows: 'garbage' }, { ttlMs: 1e9 });
  const g = new ScreenerFeed(s.dl, { preset: 'organic', snapshot: true, now: () => now });
  assert.equal(g.rows.length, 0, 'a malformed snapshot is ignored');
  s.done();
});

/** A screener view row (what the feed renders) with no data source behind it. */
function rowView(mint: string): ScreenerRow {
  return { mint, symbol: mint, name: mint, launchpad: 'pump.fun' as const, price: 1, mcap: 1, mcapFlagged: false, fdv: 1, liq: 1, vol24: 1, vol6h: 1, vol1h: 1, vol5m: 1, ageMin: 1, holders: null, holders24: null, holdersChgPct: null, chg: { m5: null, h1: null, h6: null, h24: null }, spark: undefined, buys: null, sells: null, org: null, top10: null, dev: null, lpLocked: null, mintAuth: null, freezeAuth: null, snipers: null, bundled: null, flags: [], verified: false, sus: false, bonding: null, pair: null, sources: [], stale: false, fetchedAt: null, aiNote: null, image: null };
}

test('fast first paint: ONE list, DexScreener-only (jup cache), painted before the other lists are fetched', async () => {
  const now = 1_700_000_000_000;
  const s = stub({
    discover: lists({ trending: ['a', 'b'], organic: ['c'], recent: ['d'] }),
    // 'a' was seeded by a Jupiter list (has jupiter-tokens); 'b' came from DexScreener boosts only.
    enrich: async (bt, o) => ({ rows: bt.map((m) => row(m, { sources: o?.jup === 'cache' && m === 'b' ? ['dexscreener'] : ['dexscreener', 'jupiter-tokens'] })), errors: {} }),
  }, () => now);
  const f = new ScreenerFeed(s.dl, { preset: 'trench', fastFirstPaint: true, now: () => now });
  let firstPaintCalls = -1;
  f.onProgress = () => { if (firstPaintCalls < 0 && f.rows.length) firstPaintCalls = s.calls.length; };
  await f.refresh();
  assert.deepEqual(s.calls, [
    'discover trending',
    'enrich a,b jup:cache',     // first paint: no Jupiter request can sit in front of it
    'discover organic',
    'discover recent',
    'enrich b,c,d',             // 'b' painted without Jupiter fields: re-enriched with them now
  ]);
  assert.equal(firstPaintCalls, 2, 'rows were on screen after one discovery + one DexScreener enrich');
  assert.deepEqual(f.rows.map((r) => r.mint), ['a', 'b', 'c', 'd']);
  s.done();
});

test('fast first paint is off by default: the compact request set (recordings/replays) is unchanged', async () => {
  const now = 1_700_000_000_000;
  const s = stub({ discover: lists({ trending: ['a', 'b'], organic: ['c'], recent: ['d'] }), enrich: enrichAll }, () => now);
  const f = new ScreenerFeed(s.dl, { preset: 'trench', now: () => now });
  await f.refresh();
  assert.deepEqual(s.calls, ['discover trending', 'discover organic', 'discover recent', 'enrich a,b,c,d']);
  s.done();
});

test('(b) skeleton rows while a live feed has nothing yet; never on error, fixtures, or once rows land', () => {
  const sc = makeScreenerState('live', []);
  assert.equal(showsSkeleton(sc), true);
  const v = screenerView(sc);
  assert.ok(v.length >= 8 && v.every((r) => r.skeleton && r.mint === '' && r.price === null), 'placeholder rows with no data');
  assert.equal(screenerView({ ...sc, errors: { dexscreener: 'fetch failed' } }).length, 0, 'offline keeps the explicit banner');
  assert.equal(screenerView({ ...sc, errors: { jupiter: 'HTTP 429' } }).length, 0, 'rate-limited keeps the banner');
  assert.equal(screenerView(makeScreenerState('fixtures', [])).length, 0);
  const live = makeScreenerState('live', [rowView('x')]);
  assert.deepEqual(screenerView(live).map((r) => r.mint), ['x']);
  // A user filter that matches nothing is "no tokens match", not a skeleton.
  assert.equal(showsSkeleton(live), false);
});

test('(b) skeleton rows open nothing and cannot be watched', () => {
  const state = makeFixtureState({ calm: true });
  state.screener = makeScreenerState('live', []);
  state.screen = 'screener';
  state.selected = 0;
  applyAction(state, 'open', []);
  assert.equal(state.screen, 'screener', '⏎ on a placeholder row stays on the screener');
});

test('(c) fallback: the default feed shows nothing within the budget → Trending, and the slow refresh is orphaned', async () => {
  const now = 1_700_000_000_000;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let n = 0;
  const s = stub({
    discover: async (f) => {
      if (n++ === 0) { await gate; return { mints: ['slow1'], errors: {} }; } // trench's first list hangs
      return { mints: f === 'trending' ? ['t1', 't2'] : [], errors: {} };
    },
    enrich: enrichAll,
  }, () => now);
  const f = new ScreenerFeed(s.dl, { preset: 'trench', fastFirstPaint: true, fallback: { preset: 'trending', afterMs: 30 }, now: () => now });
  const boot = f.refresh();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(f.preset, 'trending', 'switched after the budget with zero rows');
  assert.deepEqual(f.fellBack, { from: 'trench', reason: 'slow' });
  assert.deepEqual(f.rows.map((r) => r.mint), ['t1', 't2'], 'trending rows painted');
  assert.match(f.status().headerStatus ?? '', /trench slow → trending/);
  release();
  await boot;
  assert.deepEqual(f.rows.map((r) => r.mint), ['t1', 't2'], 'the orphaned trench refresh wrote nothing');
  s.done();
});

test('(c) fallback: the default feed comes back with nothing to show → Trending', async () => {
  const now = 1_700_000_000_000;
  const s = stub({
    discover: lists({ trending: ['v1', 'v2'] }),
    // every row is Jupiter-verified: trench's baked `verified:no` filter hides them all (raw rows exist)
    enrich: async (b) => ({ rows: b.map((m) => row(m, { verified: true })), errors: {} }),
  }, () => now);
  const f = new ScreenerFeed(s.dl, { preset: 'trench', fallback: { preset: 'trending', afterMs: 60_000 }, now: () => now });
  await f.refresh();
  assert.equal(f.preset, 'trending');
  assert.equal(f.fellBack?.reason, 'empty');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.shownCount(), 2, 'Trending (no baked filter) shows them');
  s.done();
});

test('(c) no fallback when rows are on screen in time, or when a cached feed is showing', async () => {
  const now = 1_700_000_000_000;
  const s = stub({ discover: lists({ trending: ['a'] }), enrich: enrichAll }, () => now);
  const f = new ScreenerFeed(s.dl, { preset: 'trench', snapshot: true, fastFirstPaint: true, fallback: { preset: 'trending', afterMs: 30 }, now: () => now });
  await f.refresh();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(f.preset, 'trench');
  assert.equal(f.fellBack, null);
  f.close();
  // Next launch: the trench snapshot is on screen while the first fetch hangs past the budget.
  const hang = stub({ discover: () => new Promise(() => {}), enrich: enrichAll }, () => now, s.dir);
  const g = new ScreenerFeed(hang.dl, { preset: 'trench', snapshot: true, fastFirstPaint: true, fallback: { preset: 'trending', afterMs: 30 }, now: () => now });
  assert.equal(g.fromSnapshot, true);
  void g.refresh();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(g.preset, 'trench', 'cached rows on screen: never yanked to another preset');
  g.close();
  hang.done();
  s.done();
});

test('preset switch mid-refresh: the old refresh is orphaned and the new preset refreshes at once', async () => {
  const now = 1_700_000_000_000;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const s = stub({
    discover: async (f) => { if (f === 'recent') { await gate; return { mints: ['r1'], errors: {} }; } return { mints: f === 'organic' ? ['o1'] : [], errors: {} }; },
    enrich: enrichAll,
  }, () => now);
  const f = new ScreenerFeed(s.dl, { preset: 'new', now: () => now });
  const old = f.refresh();
  assert.equal(f.refreshing, true);
  assert.equal(f.setPreset('organic'), true);
  assert.equal(f.refreshing, false, 'the switch frees the refresh slot');
  await f.refresh();
  assert.deepEqual(f.rows.map((r) => r.mint), ['o1']);
  release();
  await old;
  assert.deepEqual(f.rows.map((r) => r.mint), ['o1'], 'the orphaned refresh never overwrote the new preset');
  assert.equal(f.refreshing, false);
  s.done();
});
