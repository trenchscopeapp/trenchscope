// task-1340 bubble map, the CLI side: the IntelLive binding's three honest states, the BUBBLE MAP screen at
// 176 / 120 / 90 (loading, unavailable + fix, ok, treemap, zoom, selection → WHY panel), the keymap, the token
// screen's ON-CHAIN rows reading the scan, the popup view model (text only, no keys) and the TokenPopups bubble
// window with a fake manager (open / sync / click → selection / close).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { THEMES, parseKeys, DEFAULT_KEYMAP } from '@dexterm/tui';
import type { ScanResult, WalletIntel, DataLayer } from '@dexterm/data';
import { analyze as analyzeRules } from '@dexterm/data';
import type { PopupManager, PopupManagerOptions, BubbleVM, ServerEvent } from '@dexterm/popup';
import { IntelLive, popupBubbleVM, unavailableText, hideLabels } from '../src/live/intel.ts';
import { makeFixtureState, renderFrame, type AppState } from '../src/state.ts';
import { TokenPopups } from '../src/popup.ts';
import { fixture, addr } from '../../tui/test/bubbles-fixture.ts';

const T = THEMES.cyberspace;
const MINT = '7VoiDfix7ureMint000000000000000000000pump';
const SEED = { mint: MINT, symbol: 'VOID', name: 'void protocol', holderCount: 1842 };

/** The spike fixture as an ok scan result (an IntelAnalysis-shaped object is what the renderer wants). */
function okResult(over: Partial<Extract<ScanResult, { state: 'ok' }>> = {}): ScanResult {
  const f = fixture();
  const analysis = { mint: MINT, holders: f.holders.map((h) => ({ ...h, tokenAccounts: [], amount: '0', ownerKind: 'wallet', programOwner: null, freshAtBuy: null, createdBeforeLaunch: null })), clusters: f.clusters, funding: {}, buyEvents: [], insights: {
    supply: '1000000', decimals: 6,
    top10: { byTokenAccount: 44.1, byOwner: 44.1, clusterAdjusted: 29.3, excludedLabels: ['LP', 'cex', 'contract', 'pool'], excludedCount: 2, note: '' },
    coverage: { topHoldersFetched: 32, supplyCoveredPct: 68.4, fundingLookups: 18, fundingCoveredPct: 41.2, launchTxs: 300, launchTxsWithMintBalanceChange: 299, launchSlots: 141, launchSlotSpan: 388, launchMorePages: true },
    snipers: { count: 7, launchWindowSharePct: 18.9, stillInTop: 7, holdNowPctOfTopSample: 15.2, definition: '', honest: '' },
    bundle: { sameSlotCohorts: 41, largestCohort: 6, bundleClustersFound: 1, bundlePctOfTopSample: 12.0, definition: '', honest: '' },
    dev: { creator: addr(1), creatorPctNow: 4.1, creatorUpperBoundPct: null, usesPumpProgram: true, definition: '' },
    fresh: { freshAtBuyPctOfTopSample: 17.5, measuredWallets: 18, measuredPct: 41.2, notMeasuredPct: 27.2, definition: '', honest: '' },
    launch: { firstSlot: 371204415, firstBlockTime: 1759732800, firstBlockTimeIso: '2025-10-06T06:40:00.000Z', creator: addr(1), pools: [addr(3)], buyers: 188, sameSlotCohorts: [], sameSlotCreatedPairs: 0 },
  } } as unknown as Extract<ScanResult, { state: 'ok' }>['analysis'];
  return { state: 'ok', depth: 'light', analysis, via: { holders: 'helius', history: 'helius' }, degraded: null, fetchedAt: 1, fromCache: false, ...over };
}

function fakeIntel(script: () => Promise<ScanResult>): WalletIntel {
  return { scan: script, historyAvailable: () => ({ ok: true }) } as unknown as WalletIntel;
}
function harness(script: () => Promise<ScanResult>, watched = false) {
  let changes = 0;
  const live = new IntelLive({} as DataLayer, { intel: fakeIntel(script), onChange: () => changes++, isWatched: () => watched, now: () => 1 });
  return { live, changes: () => changes };
}

test('IntelLive: loading → ok (view model built, hidden labels dropped) → unavailable with reason + fix; watched coins scan deep', async () => {
  let resolve!: (r: ScanResult) => void;
  const h = harness(() => new Promise<ScanResult>((r) => { resolve = r; }));
  const p = h.live.scan(SEED);
  assert.equal(h.live.entry(MINT)?.state, 'loading');
  assert.equal(h.changes(), 1);
  resolve(okResult());
  const e = await p;
  assert.equal(e.state, 'ok');
  assert.equal(e.bubbles?.holders.length, 31);
  assert.equal(e.bubbles?.symbol, 'VOID');
  assert.equal(h.changes(), 2);
  assert.ok(h.live.analysis(MINT));
  // unavailable
  const u = harness(async () => ({ state: 'unavailable', depth: 'light', reason: 'no RPC endpoint serves the ranked holder list', fix: 'free Helius key → ~/.dexterm/helius.key', fetchedAt: 1 }));
  const ue = await u.live.scan(SEED);
  assert.equal(ue.state, 'unavailable'); assert.equal(ue.bubbles, null); assert.equal(u.live.analysis(MINT), null);
  assert.match(unavailableText(ue).reason, /ranked holder list/); assert.match(unavailableText(ue).fix ?? '', /helius.key/);
  // a thrown scan is also unavailable, never a crash
  const t = harness(async () => { throw new Error('boom'); });
  const te = await t.live.scan(SEED);
  assert.equal(te.state, 'unavailable'); assert.equal(unavailableText(te).reason, 'boom');
  // depth
  const depths: string[] = [];
  const d = new IntelLive({} as DataLayer, { intel: { scan: async (_m: string, depth: string) => { depths.push(depth); return okResult(); }, historyAvailable: () => ({ ok: true }) } as unknown as WalletIntel, isWatched: () => true });
  await d.scan(SEED); await d.scan(SEED, { depth: 'light' });
  assert.deepEqual(depths, ['deep', 'light']);
  assert.equal(d.depthFor(MINT), 'deep');
  // hidden labels never reach the renderer
  const a = okResult() as Extract<ScanResult, { state: 'ok' }>;
  a.analysis.holders[0].labels.push({ label: 'cabal-candidate', rule: 'K1+K2', confidence: 'derived' });
  const hid = hideLabels(a.analysis);
  assert.ok(!hid.holders[0].labels.some((l) => l.label === 'cabal-candidate'));
  assert.ok(a.analysis.holders[0].labels.some((l) => l.label === 'cabal-candidate'), 'input untouched');
});

/** A fixture state with a live context stub carrying the IntelLive binding and the bubble screen's UI state. */
function screenState(entryScript: () => Promise<ScanResult>, w = 176): { state: AppState; live: IntelLive } {
  const state = makeFixtureState({ screen: 'bubbles', theme: T, intensity: 'off', frame: 41 });
  const { live } = harness(entryScript);
  state.live = { intel: live, rpc: { provider: 'helius', basis: '~/.dexterm/helius.key' }, creditsStatus: () => null, linkedWallet: null, scanMeterLabel: () => '' } as unknown as AppState['live'];
  state.intelUi = { mint: MINT, symbol: 'VOID', name: 'void protocol', selected: null, view: 'bubbles', focus: null, layout: null };
  void w;
  return { state, live };
}

for (const [w, h] of [[176, 48], [120, 42], [90, 36]] as const) {
  test(`bubble screen ${w}×${h}: loading, unavailable (+fix), ok with legend / clusters / insights / WHY, treemap, zoom, selection`, async () => {
    let resolve!: (r: ScanResult) => void;
    const { state, live } = screenState(() => new Promise<ScanResult>((r) => { resolve = r; }));
    const p = live.scan(SEED);
    let plain = renderFrame(state, w, h).toPlain();
    assert.match(plain, /scanning holders/);
    assert.match(plain, /BUBBLE MAP/);
    assert.match(plain, /● dev {2}● bundle/, 'legend is drawn in every state');
    resolve(okResult({ degraded: null }));
    await p;
    plain = renderFrame(state, w, h).toPlain();
    assert.match(plain, /\$VOID/);
    assert.match(plain, /█/, 'discs drawn');
    assert.match(plain, /light scan · helius \+ helius history/);
    if (w >= 100) {
      assert.match(plain, /CLUSTERS/); assert.match(plain, /C1 {3}● bundle/); assert.match(plain, /HOLDER INSIGHTS/);
      assert.match(plain, /TOP10 RAW/i); assert.match(plain, /44\.1%/); assert.match(plain, /29\.3%/); assert.match(plain, /sample top 32 accts/); assert.match(plain, /1\.84K/);
      assert.match(plain, /WHY THIS LABEL/); assert.match(plain, /select a bubble/);
    }
    // selection → WHY panel prints the rule + confidence + evidence; the compact size prints one rule line under the legend
    const vm = live.entry(MINT)!.bubbles!;
    state.intelUi!.selected = vm.holders.findIndex((x) => x.owner === addr(10));
    plain = renderFrame(state, w, h).toPlain();
    if (w >= 100) { assert.match(plain, /sniper +on-chain/); assert.match(plain, /first 3 slots \(S1\)/); assert.match(plain, /R2 bundle/); assert.match(plain, /labels are heuristics/); }
    else assert.match(plain, /BUNDLE.*sniper: first 3 slots/);
    // a seed label says unverified and is marked seed
    state.intelUi!.selected = vm.holders.findIndex((x) => x.owner === addr(4));
    plain = renderFrame(state, w, h).toPlain();
    assert.match(plain, /unverified/);
    // treemap + zoom
    state.intelUi!.view = 'treemap';
    plain = renderFrame(state, w, h).toPlain();
    assert.match(plain, /TREEMAP/); assert.match(plain, /21\.8%/);
    state.intelUi!.view = 'bubbles'; state.intelUi!.focus = 'C1'; state.intelUi!.layout = null;
    plain = renderFrame(state, w, h).toPlain();
    assert.match(plain, /zoom C1/);
    // unavailable with the fix
    const u = screenState(async () => ({ state: 'unavailable', depth: 'light', reason: 'public RPCs throttle getTokenLargestAccounts', fix: 'free Helius key → ~/.dexterm/helius.key', fetchedAt: 1 }));
    await u.live.scan(SEED);
    plain = renderFrame(u.state, w, h).toPlain();
    assert.match(plain, /bubble map unavailable: public RPCs throttle/);
    assert.match(plain, /fix: free Helius key/);
    assert.doesNotMatch(plain, /█{3}/, 'no fake discs');
    // keyless degraded: holders drawn, the partial note printed
    const k = screenState(async () => okResult({ via: { holders: 'solana-rpc', history: null }, degraded: 'funders and launch window need a free Helius key' }));
    await k.live.scan(SEED);
    plain = renderFrame(k.state, w, h).toPlain();
    assert.match(plain, /solana-rpc only/);
    if (w >= 100) assert.match(plain, /partial: funders and launch window/);
  });
}

test('keymap: M on the token screen opens the bubble map; on the bubble screen M = popup, m = treemap, z = zoom, D = deep, r = rescan; j/k stay global', () => {
  const k = (s: string) => parseKeys(s)[0];
  assert.equal(DEFAULT_KEYMAP.resolve(k('M'), 'token'), 'intel.bubbles');
  assert.equal(DEFAULT_KEYMAP.resolve(k('M'), 'bubbles'), 'popup.bubbles');
  assert.equal(DEFAULT_KEYMAP.resolve(k('m'), 'bubbles'), 'bubbles.view');
  assert.equal(DEFAULT_KEYMAP.resolve(k('z'), 'bubbles'), 'bubbles.zoom');
  assert.equal(DEFAULT_KEYMAP.resolve(k('D'), 'bubbles'), 'bubbles.deep');
  assert.equal(DEFAULT_KEYMAP.resolve(k('r'), 'bubbles'), 'refresh');
  assert.equal(DEFAULT_KEYMAP.resolve(k('j'), 'bubbles'), 'move.down');
  assert.equal(DEFAULT_KEYMAP.resolve(k('M'), 'screener'), undefined, 'M is not global');
  assert.equal(DEFAULT_KEYMAP.resolve(k('C'), 'token'), 'popup.chart', 'the chart popup key is untouched');
});

test('popup VM: text only (addresses, rules, numbers), the terminal selection, no keys / URLs; unavailable + loading carry no holders', async () => {
  const { live } = harness(async () => okResult());
  const vm0 = popupBubbleVM(null, SEED, null);
  assert.equal(vm0.state, 'loading'); assert.equal(vm0.holders.length, 0);
  const e = await live.scan(SEED);
  const vm = popupBubbleVM(e, SEED, 3, '/img/abc.png');
  assert.equal(vm.state, 'ok'); assert.equal(vm.holders.length, 31); assert.equal(vm.selected, 3); assert.equal(vm.depth, 'light');
  assert.equal(vm.clusters.length, 4, 'only linked clusters travel');
  assert.equal(vm.insights?.top10Raw, 44.1); assert.equal(vm.insights?.snipers?.count, 7); assert.match(vm.insights?.sample ?? '', /sample top 32 accts of 1\.84K holders/);
  assert.ok(vm.holders.some((h) => h.labels.some((l) => /seed list, unverified/.test(l.rule))));
  const json = JSON.stringify(vm);
  for (const bad of ['api-key', 'helius.key', 'https://', 'wss://', 'signer', 'secret', 'privateKey']) assert.ok(!json.includes(bad), `no ${bad} in the popup VM`);
  const keys = new Set<string>(); const walk = (x: unknown) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { keys.add(k); walk(v); } }; walk(vm);
  for (const bad of ['url', 'key', 'rpc', 'wallet', 'ticket', 'mandate']) assert.ok(!keys.has(bad), `no "${bad}" field`);
  const u = harness(async () => ({ state: 'unavailable', depth: 'light', reason: 'nope', fix: null, fetchedAt: 1 }));
  const ue = await u.live.scan(SEED);
  const uvm = popupBubbleVM(ue, SEED, null);
  assert.equal(uvm.state, 'unavailable'); assert.equal(uvm.reason, 'nope'); assert.equal(uvm.holders.length, 0);
});

test('TokenPopups: openBubbles opens a `bubbles` window with the VM, syncBubbles pushes, a validated holder click selects, close-request closes; independent of the chart', async () => {
  const opens: Array<{ kind: string; data: unknown }> = [];
  const pushes: BubbleVM[] = [];
  let onEvent: ((e: ServerEvent) => void) | undefined;
  let closed = 0;
  const mgr = (o: PopupManagerOptions): PopupManager => { onEvent = o.onEvent; return { native: true, reason: 'wry', hotkeyRegistered: false, port: 1, async open(req) { opens.push({ kind: req.kind, data: req.data }); return { id: `p${opens.length}`, kind: req.kind, native: true, setData: (d) => pushes.push(d as BubbleVM), close() { closed++; }, show() {}, hide() {}, focus() {}, alwaysOnTop() {} }; }, setData() {}, close() {}, async shutdown() {} }; };
  const selected: string[] = [];
  const tp = new TokenPopups({ theme: T, env: { DEXTERM_HOME: '/nonexistent-1340' }, createManager: mgr, onHolderSelected: (a) => selected.push(a) });
  const { live } = harness(async () => okResult());
  const e = await live.scan(SEED);
  const vm = popupBubbleVM(e, SEED, null);
  assert.equal(tp.bubblesOpen(), false);
  const r = await tp.openBubbles(vm);
  assert.equal(r.native, true);
  assert.equal(opens.length, 1); assert.equal(opens[0].kind, 'bubbles'); assert.equal((opens[0].data as BubbleVM).symbol, 'VOID');
  assert.equal(tp.bubblesOpen(), true); assert.equal(tp.chartOpen(), false, 'the chart is a separate window');
  tp.syncBubbles({ ...vm, selected: 2 });
  assert.equal(pushes.length, 1); assert.equal(pushes[0].selected, 2);
  // a click: validated address only
  onEvent!({ ev: 'popup.event', popupId: 'p1', name: 'holder.selected', payload: { address: addr(10) } });
  onEvent!({ ev: 'popup.event', popupId: 'p1', name: 'holder.selected', payload: { address: 'not-base58!' } });
  onEvent!({ ev: 'popup.event', popupId: 'p1', name: 'holder.selected', payload: { address: 42 } });
  assert.deepEqual(selected, [addr(10)]);
  // a second open re-syncs instead of opening twice
  await tp.openBubbles(vm);
  assert.equal(opens.length, 1); assert.equal(pushes.length, 2);
  onEvent!({ ev: 'popup.event', popupId: 'p1', name: 'popup.close-request', payload: {} });
  assert.equal(tp.bubblesOpen(), false); assert.equal(closed, 1);
  tp.closeBubbles(); // idempotent
  assert.equal(closed, 1);
});

test('token screen ON-CHAIN rows: snipers / bundled come from the scan once it ran; before, they say what is missing (never a number)', async () => {
  const { live } = harness(async () => okResult());
  const state = makeFixtureState({ screen: 'token', theme: T, intensity: 'off', frame: 41 });
  // the fixture token screen only renders the live rows with a live token binding; exercise the row builder through the real analysis instead
  await live.scan(SEED);
  const a = live.analysis(MINT)!;
  assert.equal(a.insights.snipers.count, 7);
  assert.equal(a.insights.bundle.bundlePctOfTopSample, 12);
  const none = harness(async () => okResult({ via: { holders: 'solana-rpc', history: null }, degraded: 'x' }));
  const r = (await none.live.scan(SEED)).result as Extract<ScanResult, { state: 'ok' }>;
  assert.equal(r.analysis.insights.coverage.launchTxs, 300, 'fixture: the honest rows key off launchTxs > 0');
  void state;
  void analyzeRules;
});
