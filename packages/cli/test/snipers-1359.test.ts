// task-1359 snipers / bundles from the wallet-intel scan on the LIVE new-pairs list: the shared cell helper
// (numbers only once the launch window was read, an honest reason otherwise), the dwell scan of the selected
// row (Helius-keyed only, never twice), and the new-pairs table + spotlight drawing the scanned values.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { THEMES } from '@dexterm/tui';
import type { ScanResult, WalletIntel, DataLayer } from '@dexterm/data';
import { IntelLive, launchIntelCells } from '../src/live/intel.ts';
import { LiveContext } from '../src/live/index.ts';
import { createReplayFeed } from '../src/feed.ts';
import { makeFeedState, renderFrame } from '../src/state.ts';
import { fixture, addr } from '../../tui/test/bubbles-fixture.ts';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const T1298 = resolve(here, '..', '..', 'data', 'fixtures', 'task-1298-sample.json');
const MINT = '7VoiDfix7ureMint000000000000000000000pump';

function okResult(launchTxs = 300, snipers = 7, sharePct = 18.9, bundlePct = 12.0): ScanResult {
  const f = fixture();
  const analysis = { mint: MINT, holders: f.holders.map((h) => ({ ...h, tokenAccounts: [], amount: '0', ownerKind: 'wallet', programOwner: null, freshAtBuy: null, createdBeforeLaunch: null })), clusters: f.clusters, funding: {}, buyEvents: [], insights: {
    supply: '1000000', decimals: 6,
    top10: { byTokenAccount: 44.1, byOwner: 44.1, clusterAdjusted: 29.3, excludedLabels: [], excludedCount: 0, note: '' },
    coverage: { topHoldersFetched: 32, supplyCoveredPct: 68.4, fundingLookups: 18, fundingCoveredPct: 41.2, launchTxs, launchTxsWithMintBalanceChange: launchTxs, launchSlots: 141, launchSlotSpan: 388, launchMorePages: false },
    snipers: { count: snipers, launchWindowSharePct: sharePct, stillInTop: snipers, holdNowPctOfTopSample: 15.2, definition: '', honest: '' },
    bundle: { sameSlotCohorts: 41, largestCohort: 6, bundleClustersFound: 1, bundlePctOfTopSample: bundlePct, definition: '', honest: '' },
    dev: { creator: addr(1), creatorPctNow: 4.1, creatorUpperBoundPct: null, usesPumpProgram: true, definition: '' },
    fresh: { freshAtBuyPctOfTopSample: 17.5, measuredWallets: 18, measuredPct: 41.2, notMeasuredPct: 27.2, definition: '', honest: '' },
    launch: { firstSlot: 1, firstBlockTime: 1, firstBlockTimeIso: '', creator: addr(1), pools: [], buyers: 188, sameSlotCohorts: [], sameSlotCreatedPairs: 0 },
  } } as unknown as Extract<ScanResult, { state: 'ok' }>['analysis'];
  return { state: 'ok', depth: 'light', analysis, via: { holders: 'helius', history: launchTxs > 0 ? 'helius' : null }, degraded: null, fetchedAt: 1, fromCache: false };
}

function intelWith(script: (mint: string) => Promise<ScanResult>, history = true): { live: IntelLive; scans: string[] } {
  const scans: string[] = [];
  const intel = { scan: (m: string) => { scans.push(m); return script(m); }, historyAvailable: () => (history ? { ok: true } : { ok: false, why: 'funders and launch window need a free Helius key' }) } as unknown as WalletIntel;
  return { live: new IntelLive({} as DataLayer, { intel, now: () => 1 }), scans };
}

test('launchIntelCells: numbers + levels only once the launch window was read; otherwise scanning / needs Helius key / not scanned, short form a dash', async () => {
  // no binding at all (fixtures / demo)
  const none = launchIntelCells(null, MINT);
  assert.equal(none.measured, false); assert.equal(none.snipers.short, '—'); assert.equal(none.snipers.text, 'needs Helius key');
  // keyed but never scanned
  const k = intelWith(async () => okResult());
  assert.deepEqual(launchIntelCells(k.live, MINT, 'not scanned yet').bundle, { text: 'not scanned yet', short: '—', level: 'na' });
  // in flight
  let resolve!: (r: ScanResult) => void;
  const p = intelWith(() => new Promise<ScanResult>((r) => { resolve = r; }));
  const pending = p.live.scan({ mint: MINT, symbol: 'VOID' });
  assert.deepEqual(launchIntelCells(p.live, MINT).snipers, { text: 'scanning…', short: '…', level: 'na' });
  resolve(okResult()); await pending;
  const c = launchIntelCells(p.live, MINT);
  assert.equal(c.measured, true);
  assert.deepEqual(c.snipers, { text: '7 · 18.9% at launch', short: '7', level: 'warn' });
  assert.deepEqual(c.bundle, { text: '12.0% · 41 cohorts', short: '12%', level: 'warn' });
  // thresholds: >20% at launch = bad, >15% bundled = bad, small = ok
  const bad = intelWith(async () => okResult(300, 2, 31, 22));
  await bad.live.scan({ mint: MINT, symbol: 'VOID' });
  assert.equal(launchIntelCells(bad.live, MINT).snipers.level, 'bad'); assert.equal(launchIntelCells(bad.live, MINT).bundle.level, 'bad');
  const ok = intelWith(async () => okResult(300, 1, 2, 1));
  await ok.live.scan({ mint: MINT, symbol: 'VOID' });
  assert.equal(launchIntelCells(ok.live, MINT).snipers.level, 'ok'); assert.equal(launchIntelCells(ok.live, MINT).bundle.level, 'ok');
  // a keyless scan (holders only, no launch window) never prints a number
  const kl = intelWith(async () => okResult(0), false);
  await kl.live.scan({ mint: MINT, symbol: 'VOID' });
  const kc = launchIntelCells(kl.live, MINT);
  assert.equal(kc.measured, false); assert.equal(kc.snipers.text, 'needs Helius key'); assert.equal(kc.bundle.short, '—');
});

test('scanSelectedLater: Helius-keyed only, one pending scan (the next move cancels it), never re-scans a mint already ok or in flight', async () => {
  const keyless = intelWith(async () => okResult(), false);
  assert.equal(keyless.live.scanSelectedLater({ mint: MINT, symbol: 'VOID' }, 0), false);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(keyless.scans, [], 'no public-RPC spend for a dash');
  const k = intelWith(async () => okResult());
  assert.equal(k.live.scanSelectedLater({ mint: 'A'.repeat(43), symbol: 'A' }, 20), true);
  assert.equal(k.live.scanSelectedLater({ mint: MINT, symbol: 'VOID' }, 0), true, 'the cursor moved on: the first dwell is cancelled');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(k.scans, [MINT]);
  assert.equal(k.live.scanSelectedLater({ mint: MINT, symbol: 'VOID' }, 0), false, 'already scanned');
  k.live.close();
});

test('live NEW PAIRS: SNIPE / BUNDLE columns and the spotlight read the scan of that row; unscanned rows keep the dash', async () => {
  const feed = createReplayFeed(T1298);
  const store = feed.replayStore!;
  const now = Date.parse(store.recordedAt!);
  const ctx = new LiveContext(feed.dl, { mode: 'replay', replay: store, now: () => now, polls: { recent: false, enrich: false, newTokens: false } });
  await ctx.startFeed(0);
  const rows = ctx.newpairs.list();
  assert.ok(rows.length > 2);
  const target = rows[0].mint;
  const k = intelWith(async () => okResult(300, 9, 24.5, 17.2));
  (ctx as unknown as { intel: IntelLive }).intel = k.live;
  const state = makeFeedState(feed, 'replay', { screen: 'newpairs', theme: THEMES.midnight, intensity: 'off' });
  state.live = ctx;
  state.now = new Date(now);
  state.selected = 0;
  let plain = renderFrame(state, 176, 48).toPlain();
  assert.match(plain, /SNIPE/); // BUNDLE is a prio-4 column: shown only when the table has room
  assert.match(plain, /Snipers \(first 3 slots\)/);
  assert.match(plain, /scans after ~2 s on this row/, 'keyed + unscanned: the spotlight says when it will scan');
  assert.doesNotMatch(plain, /needs Helius history \(W1\)/, 'the old stub text is gone');
  await k.live.scan({ mint: target, symbol: rows[0].symbol });
  plain = renderFrame(state, 176, 48).toPlain();
  assert.match(plain, /9 · 24\.5% at launch/);
  assert.match(plain, /17\.2% · 41 cohorts/);
  const sel = plain.split('\n').find((l) => l.includes(`▎   1s ${rows[0].symbol}`));
  assert.ok(sel && /—\s+9\s/.test(sel), `the selected row carries 9 snipers in its SNIPE column: ${sel}`);
  const unscanned = plain.split('\n').find((l) => l.includes(`    1s ${rows[1].symbol} `));
  assert.ok(unscanned && /—\s+—\s+—\s/.test(unscanned), 'an unscanned row keeps DEV / SNIPE dashes (no number invented)');
  // a wide terminal shows the BUNDLE column too
  const wide = renderFrame(state, 220, 48).toPlain().split('\n').find((l) => l.includes(`▎   1s ${rows[0].symbol}`));
  assert.ok(wide && /\s9\s+17%/.test(wide), `wide: SNIPE 9 · BUNDLE 17%: ${wide}`);
  for (const [w, h] of [[120, 40], [90, 40]] as const) {
    const lines = renderFrame(state, w, h).toPlain().split('\n');
    assert.equal(lines.length, h);
    for (const row of lines) assert.ok([...row].length <= w, `row wider than ${w}`);
  }
  ctx.close();
  feed.close();
});

test('LiveContext: a settled wallet-intel scan of the open token becomes chain rows in its SOCIAL feed (clusters + snipers), once per scan', async () => {
  const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'; // the social feed only accepts valid base58 mints
  const feed = createReplayFeed(T1298);
  const store = feed.replayStore!;
  const now = Date.parse(store.recordedAt!);
  const ctx = new LiveContext(feed.dl, { mode: 'replay', replay: store, now: () => now, polls: { recent: false, enrich: false, newTokens: false } });
  // the open token (only its mint is read) and a fake history-capable WalletIntel behind the real IntelLive
  (ctx as unknown as { token: { view: { mint: string } } }).token = { view: { mint: WIF } };
  (ctx.intel as unknown as { intel: WalletIntel }).intel = { scan: async () => ({ ...okResult(), fetchedAt: now - 2_000 }), historyAvailable: () => ({ ok: true }) } as unknown as WalletIntel; // a real scan carries its fetch time (the feed keeps 24 h)
  await ctx.intel.scan({ mint: WIF, symbol: 'WIF' });
  const posts = ctx.social.postsFor(WIF);
  assert.ok(posts.some((p) => p.platform === 'chain' && /^7 sniper wallets took 18\.9% of the launch window/.test(p.text)), posts.map((p) => p.text).join('\n'));
  assert.ok(posts.some((p) => p.platform === 'chain' && /of supply sits in \d+ wallets that/.test(p.text)), 'linked clusters from the fixture scan');
  const n = posts.length;
  await ctx.intel.scan({ mint: WIF, symbol: 'WIF' });
  assert.equal(ctx.social.postsFor(WIF).length, n, 'the same scan (same fetch time) adds nothing');
  (ctx as unknown as { token: null }).token = null;
  ctx.close();
  feed.close();
});
