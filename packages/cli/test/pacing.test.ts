// task-1303 rework: the wide-pool DexScreener budget (DsPacer) and the idle-effects predicate
// (fxBusy) that drive the pacing + idle-CPU fixes. Pure units, no network and no timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DataLayer, EnrichedRow } from '@dexterm/data';
import { makeVfx, pulse, stepVfx, fxBusy } from '@dexterm/tui';
import { DsPacer, DS_TARGET_RPM, ScreenerFeed } from '../src/feed.ts';

/** A minimal EnrichedRow the screener's fromSnapshot() maps without touching the network. */
function enrichedRow(mint: string): EnrichedRow {
  return {
    mint,
    token: { mint, symbol: mint, name: mint, launchpad: 'pump.fun', verified: false, sus: false, fetchedAt: 0 },
    pair: {
      pairAddress: `p-${mint}`, priceUsd: 1, fdv: 1, mcap: 1, liquidityUsd: 1,
      priceChange: { m5: null, h1: null, h6: null, h24: null },
      volume: { h24: 0, h6: 0, h1: 0, m5: 0 }, txns: {}, fetchedAt: 0,
    },
    stats: null, audit: null, price: null, mcap: null, sparkline: undefined, sources: [], stale: false,
  } as unknown as EnrichedRow;
}

test('DsPacer holds DexScreener to its rolling 60 s budget and reports the trailing rate', () => {
  let now = 0;
  const p = new DsPacer(DS_TARGET_RPM, () => now);
  // Spend the whole budget in a burst: each call is one slot.
  assert.equal(p.wait(1), 0, 'the first call never waits');
  for (let i = 0; i < DS_TARGET_RPM; i++) p.spent(1);
  assert.equal(p.rate(), DS_TARGET_RPM, 'the window now holds a full budget of calls');
  // The next call must wait until the oldest stamp ages out of the 60 s window.
  const w = p.wait(1);
  assert.ok(w > 0 && w <= 60_000, `over budget → waits ${w} ms (1..60000)`);
  // Advance past the window: the budget frees up and no wait is needed.
  now += 60_001;
  assert.equal(p.wait(1), 0, 'after the window clears, calls flow again');
  assert.equal(p.rate(), 0, 'the trailing rate drops back to zero');
});

test('DsPacer accounts for multi-call batches (ceil(mints/30) DexScreener calls)', () => {
  let now = 0;
  const p = new DsPacer(10, () => now);
  p.spent(8);
  assert.equal(p.wait(2), 0, '8 + 2 == budget: still allowed');
  p.spent(2);
  assert.ok(p.wait(1) > 0, 'the 11th call in the window must wait');
});

test('close() aborts an in-flight paced wide-pool fill so the process can exit (task-1303 defect #1)', async () => {
  // A stub data layer: the wide phase discovers a big pool while the compact phase stays small, and
  // every enrich call bumps the DexScreener counter so the pacer (budget 1 rpm) parks the next chunk
  // behind a ~60 s rolling-window wait. close() must resolve that wait at once and bail the refresh.
  let feed!: ScreenerFeed;
  const wide = Array.from({ length: 200 }, (_, i) => `mint${i}`);
  const store = {
    discover: async (_feed: unknown, _limit: number, opts?: { max?: number }) =>
      ({ mints: opts?.max ? wide : wide.slice(0, 10), errors: {} }),
    enrich: async (batch: string[]) => {
      feed.dsCalls += Math.ceil(batch.length / 30); // simulate the real onRequest DexScreener tally
      return { rows: [], errors: {} };
    },
  };
  const dl = {
    store,
    limiter: { bucket: () => ({ stats: () => ({ pausedUntil: 0 }) }) },
    close() {},
  } as unknown as DataLayer;
  feed = new ScreenerFeed(dl, { wide: true, dsTargetRpm: 1 });

  const started = Date.now();
  const p = feed.refresh();
  await new Promise((r) => setTimeout(r, 50)); // let it reach the parked paced sleep
  feed.close();
  await p; // must resolve now, not after the ~60 s pacer wait
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `refresh resolved promptly after close (${elapsed} ms, not the ~60 s pace wait)`);
});

test('a refresh never collapses the rendered pool back to the compact feed (task-1303 defect #4)', async () => {
  // Compact discovery returns a small leading set; the wide pool returns the full net. A second
  // refresh must keep all rows on screen while it rebuilds, never dipping to the compact count.
  const wide = Array.from({ length: 200 }, (_, i) => `mint${i}`);
  const compact = wide.slice(0, 100);
  const store = {
    discover: async (_feed: unknown, _limit: number, opts?: { max?: number }) =>
      ({ mints: opts?.max ? wide : compact, errors: {} }),
    enrich: async (batch: string[]) => ({ rows: batch.map(enrichedRow), errors: {} }),
  };
  const dl = {
    store,
    limiter: { bucket: () => ({ stats: () => ({ pausedUntil: 0 }) }) },
    close() {},
  } as unknown as DataLayer;
  const feed = new ScreenerFeed(dl, { wide: true, dsTargetRpm: 1e6 });

  await feed.refresh();
  assert.equal(feed.rows.length, 200, 'first refresh fills the whole pool');

  // Watch the row count through the SECOND refresh: with the fix it only grows/holds, never collapses.
  const lengths: number[] = [];
  feed.onProgress = () => lengths.push(feed.rows.length);
  await feed.refresh();
  assert.equal(feed.rows.length, 200, 'second refresh ends at the full pool');
  assert.ok(lengths.length > 0, 'the fill reported progress');
  assert.ok(Math.min(...lengths) >= 200, `rows never dipped below the pool mid-refresh (min ${Math.min(...lengths)})`);
});

test('fxBusy is true only while an event animation is live, not for ambient rain', () => {
  const v = makeVfx({ intensity: 'fever' });
  assert.equal(fxBusy(v), false, 'a quiet fever vfx is idle (ambient rain does not count)');
  pulse(v, 'rug'); // sets glitch/shake/stutter
  assert.equal(fxBusy(v), true, 'a rug event keeps the loop at full rate');
  // Decay the event to completion; the loop may then throttle the ambient rain.
  for (let i = 0; i < 60 && fxBusy(v); i++) stepVfx(v);
  assert.equal(fxBusy(v), false, 'once the event decays the loop is idle again');
});
