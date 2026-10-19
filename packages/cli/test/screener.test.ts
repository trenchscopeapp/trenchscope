// Screener on the real store (D-03): sort, presets via the health registry, the filter editor and
// sort menu, the replayed feed, degraded sources (holders column), and the frame at 176/120/90.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HealthRegistry, FakeClock, FixtureStore, replayTransport, createDataLayer, type Transport, type HttpRequest, type HttpResponse,
} from '@dexterm/data';
import { parseKeys, THEMES, type Key, type ScreenKey } from '@dexterm/tui';
import { makeFixtures } from '../src/fixtures.ts';
import { fromFixture, fromSnapshot, cleanText, impliedSpark, type ScreenerRow } from '../src/screener/rows.ts';
import { sortRows, parseSortArg, SORT_KEYS } from '../src/screener/sort.ts';
import { presetViews, cyclePreset, bakedFilter, presetSpec, RUNNER_FILTER, PRESETS, type PresetId } from '../src/screener/presets.ts';
import { makeScreenerState, screenerView, setFilter, setSort, filterEditorKey, sortMenuKey, openFilterEditor, openSortMenu, gateCaption } from '../src/screener/view.ts';
import { ScreenerFeed, createReplayFeed, unlimitedBuckets } from '../src/feed.ts';
import { makeFixtureState, makeFeedState, syncFeed, renderFrame } from '../src/state.ts';
import { applyKey, applyAction } from '../src/main.ts';

// Any accidental live call fails loudly instead of leaving the box.
globalThis.fetch = (async (input: unknown) => { throw new Error(`network access blocked in tests: ${String(input)}`); }) as typeof fetch;

const here = dirname(fileURLToPath(import.meta.url));
export const SAMPLE = resolve(here, '..', '..', 'data', 'fixtures', 'live-sample.json');

const keys = (s: string): Key[] => parseKeys(s);
const key = (s: string): Key => keys(s)[0];

// ---------------------------------------------------------------------------------------------
// sort

test('sortRows: stable, nulls last in both directions', () => {
  const base = makeFixtures(7).tokens.map(fromFixture);
  const rows = base.map((r, i) => (i % 5 === 0 ? { ...r, holders: null } : r));
  const desc = sortRows(rows, 'holders', 'desc');
  const asc = sortRows(rows, 'holders', 'asc');
  const nulls = rows.filter((r) => r.holders === null).length;
  assert.ok(nulls > 0);
  assert.ok(desc.slice(-nulls).every((r) => r.holders === null));
  assert.ok(asc.slice(-nulls).every((r) => r.holders === null));
  const dv = desc.slice(0, -nulls).map((r) => r.holders as number);
  assert.deepEqual(dv, [...dv].sort((a, b) => b - a));
  const av = asc.slice(0, -nulls).map((r) => r.holders as number);
  assert.deepEqual(av, [...av].sort((a, b) => a - b));
  // nulls keep their input order (stability)
  assert.deepEqual(desc.slice(-nulls).map((r) => r.mint), rows.filter((r) => r.holders === null).map((r) => r.mint));
  assert.deepEqual(sortRows(rows, 'nope', 'desc'), rows, 'unknown key keeps order');
});

test('parseSortArg accepts key[:dir] and rejects junk', () => {
  assert.deepEqual(parseSortArg('liq'), { key: 'liq', dir: 'desc' });
  assert.deepEqual(parseSortArg('age'), { key: 'age', dir: 'asc' });
  assert.deepEqual(parseSortArg('mcap:asc'), { key: 'mcap', dir: 'asc' });
  assert.throws(() => parseSortArg('bogus'), /unknown sort key bogus/);
  assert.throws(() => parseSortArg('liq:sideways'), /asc or desc/);
  assert.ok(SORT_KEYS.length >= 10);
});

// ---------------------------------------------------------------------------------------------
// presets

test('presets: fixtures mode offers every feed; the health registry disables keyed ones with a caption', () => {
  assert.ok(presetViews().every((p) => p.available));
  const views = presetViews(new HealthRegistry());
  const by = Object.fromEntries(views.map((v) => [v.id, v]));
  assert.equal(by.trench.available, true, 'the trench feed is the keyless default (task-1311)');
  assert.equal(by.trending.available, true);
  assert.equal(by.runners.available, true);
  assert.equal(by.organic.available, true);
  // task-1356 Tier 6: Graduating ships as a keyless APPROXIMATION (selectable now, honest 'approx'
  // caption), upgrading to the real bonding column when that source is served. Smart money stays gated
  // off until the keyed top-traders feature lands (wallet-PnL can't be approximated keyless honestly).
  assert.equal(by.graduating.available, true, 'Graduating is served by a keyless approximation');
  assert.equal(by.graduating.approx, true);
  assert.equal(by.graduating.caption, 'approx', 'the UI labels it an approximation, not the real graduation %');
  assert.equal(by.smart.available, false);
  assert.equal(by.smart.caption, 'needs key', 'Smart money needs Birdeye/Helius (Tier 1)');
  // task-1303 feed switcher entries are keyless and always available
  assert.equal(by.traded.available, true);
  assert.equal(by.new.available, true);
  assert.equal(by.boosted.available, true);
  assert.equal(by.all.available, true);
  // a key makes Smart money selectable
  const keyed = new HealthRegistry({ keys: { helius: true } });
  assert.equal(presetViews(keyed).find((v) => v.id === 'smart')?.available, true);
  // the grammar has no real bonding-% field at this tier, so Graduating stays an approximation (always
  // available, always labelled) regardless of which sources are up; the gate only marks a future upgrade
  const gradKeyed = presetViews(new HealthRegistry({ keys: { helius: true } })).find((v) => v.id === 'graduating');
  assert.ok(gradKeyed?.available && gradKeyed.approx, 'Graduating is the keyless approximation at this tier');
  // cycling now reaches Graduating (selectable); only Smart money is skipped
  assert.equal(cyclePreset(views, 'trending', 1), 'runners');
  assert.equal(cyclePreset(views, 'organic', 1), 'graduating', 'organic steps to the keyless-approx Graduating preset');
  assert.equal(cyclePreset(views, 'graduating', 1), 'traded', 'Graduating steps past the gated Smart money to the next feed');
  assert.equal(cyclePreset(views, 'trench', -1), 'all', 'stepping back from the first (trench) wraps to the last');
  assert.equal(cyclePreset(views, 'trending', -1), 'trench', 'trench is the first feed (task-1311)');
  // presets need a filter that parses
  for (const p of PRESETS) assert.doesNotThrow(() => bakedFilter(p), p.id);
  // the Graduating approximation is a real, parseable keyless filter
  assert.ok(bakedFilter(presetSpec('graduating')!), 'Graduating has a baked keyless filter');
  assert.equal(presetSpec('Smart money')?.id, 'smart');
  assert.equal(presetSpec('RUNNERS')?.id, 'runners');
  assert.equal(presetSpec('Top traded')?.id, 'traded');
  // the live-backed feeds fold the PumpPortal new-pairs stream into the pool
  assert.equal(presetSpec('new')?.live, true);
  assert.equal(presetSpec('all')?.live, true);
  assert.ok(!presetSpec('trending')?.live);
});

test('Runners preset = Jupiter runner criteria on top of the rows', () => {
  const rows = makeFixtures(7).tokens.map(fromFixture);
  const sc = makeScreenerState('fixtures', rows);
  sc.preset = 'runners';
  const view = screenerView(sc);
  const byHand = rows.filter((r) => r.mcap! >= 1e6 && r.liq! >= 100e3 && r.holders! >= 1000 && r.org! >= 75 && r.ageMin! < 24 * 60);
  assert.deepEqual(view.map((r) => r.mint), sortRows(byHand, 'vol', 'desc').map((r) => r.mint));
  assert.match(RUNNER_FILTER, /mcap >= 1M/);
});

// ---------------------------------------------------------------------------------------------
// view-model: filter editor + sort menu

test('filter editor: typing validates live, enter applies, bad input stays open, esc cancels', () => {
  const rows = makeFixtures(7).tokens.map(fromFixture);
  const sc = makeScreenerState('fixtures', rows);
  openFilterEditor(sc);
  assert.equal(sc.mode, 'filter');
  for (const k of keys('liq > 50')) filterEditorKey(sc, k);
  assert.equal(sc.edit.text, 'liq > 50');
  assert.equal(sc.edit.error, null);
  filterEditorKey(sc, key('X'));
  const liveError = () => sc.edit.error?.error ?? '';
  assert.match(liveError(), /unknown unit "x"/);
  assert.equal(filterEditorKey(sc, key('\r')), 'handled', 'enter on a bad filter keeps the editor open');
  assert.equal(sc.mode, 'filter');
  assert.equal(sc.filter, null);
  filterEditorKey(sc, key('\x7f'));
  filterEditorKey(sc, key('K'));
  assert.equal(filterEditorKey(sc, key('\r')), 'applied');
  assert.equal(sc.mode, 'table');
  assert.equal(sc.query, 'liq > 50K');
  assert.deepEqual(screenerView(sc), sortRows(rows.filter((r) => r.liq! > 50e3), 'vol', 'desc'));
  // esc leaves the applied filter alone
  openFilterEditor(sc);
  assert.equal(sc.edit.text, 'liq > 50K');
  for (const k of keys('zzz')) filterEditorKey(sc, k);
  assert.equal(filterEditorKey(sc, key('\x1b')), 'closed');
  assert.equal(sc.query, 'liq > 50K');
  // ctrl+u clears, enter on empty removes the filter
  openFilterEditor(sc);
  filterEditorKey(sc, key('\x15'));
  assert.equal(sc.edit.text, '');
  filterEditorKey(sc, key('\r'));
  assert.equal(sc.filter, null);
  assert.equal(screenerView(sc).length, rows.length);
  // ctrl+w drops the last word
  openFilterEditor(sc);
  for (const k of keys('vol > 1M liq > 2')) filterEditorKey(sc, k);
  filterEditorKey(sc, key('\x17'));
  assert.equal(sc.edit.text, 'vol > 1M liq >');
});

test('sort menu: j/k move, enter picks with the default direction, enter on the same key flips it', () => {
  const sc = makeScreenerState('fixtures', makeFixtures(7).tokens.map(fromFixture));
  openSortMenu(sc);
  assert.equal(sc.mode, 'sort');
  assert.equal(SORT_KEYS[sc.sortCursor].key, 'vol');
  sortMenuKey(sc, key('j'));
  assert.equal(sortMenuKey(sc, key('\r')), 'applied');
  assert.deepEqual(sc.sort, { key: 'liq', dir: 'desc' });
  assert.equal(sc.mode, 'table');
  openSortMenu(sc);
  assert.equal(SORT_KEYS[sc.sortCursor].key, 'liq');
  sortMenuKey(sc, key('\r'));
  assert.deepEqual(sc.sort, { key: 'liq', dir: 'asc' }, 'same key flips direction');
  openSortMenu(sc);
  sortMenuKey(sc, key('k')); sortMenuKey(sc, key('k'));
  assert.equal(SORT_KEYS[sc.sortCursor].key, SORT_KEYS[SORT_KEYS.length - 1].key, 'wraps upward');
  assert.equal(sortMenuKey(sc, key('\x1b')), 'closed');
  assert.deepEqual(sc.sort, { key: 'liq', dir: 'asc' });
  const view = screenerView(sc);
  const liq = view.map((r) => r.liq as number);
  assert.deepEqual(liq, [...liq].sort((a, b) => a - b));
});

test('setFilter / setSort on the state', () => {
  const sc = makeScreenerState('fixtures', makeFixtures(7).tokens.map(fromFixture));
  assert.match(setFilter(sc, 'vol24 >')?.error ?? '', /needs a value/);
  assert.equal(sc.query, '');
  assert.equal(setFilter(sc, '  mcap > 10M  '), null);
  assert.equal(sc.query, 'mcap > 10M');
  setSort(sc, 'age');
  assert.deepEqual(sc.sort, { key: 'age', dir: 'asc' });
  setSort(sc, 'nope');
  assert.deepEqual(sc.sort, { key: 'age', dir: 'asc' });
});

test('applyKey routes keys: / opens the editor and swallows keys, s the sort menu, ] cycles presets, g/G jump', () => {
  const state = makeFixtureState({ screen: 'screener' });
  const stack: ScreenKey[] = [];
  applyKey(state, key('/'), stack);
  assert.equal(state.screener.mode, 'filter');
  for (const k of keys('q')) applyKey(state, k, stack); // 'q' must not quit while editing
  assert.equal(state.screener.edit.text, 'q');
  applyKey(state, key('\x1b'), stack);
  assert.equal(state.screener.mode, 'table');
  assert.equal(state.screen, 'screener');
  applyKey(state, key('s'), stack);
  assert.equal(state.screener.mode, 'sort');
  applyKey(state, key('j'), stack);
  applyKey(state, key('\r'), stack);
  assert.equal(state.screener.sort.key, 'liq');
  assert.equal(applyKey(state, key(']'), stack), undefined, 'no feed: preset change has no refresh effect');
  assert.equal(state.screener.preset, 'runners');
  applyKey(state, key('['), stack);
  assert.equal(state.screener.preset, 'trending');
  applyKey(state, key('G'), stack);
  assert.equal(state.selected, state.screener.rows.length - 1);
  // task-1388: `g` now opens the go-to prompt on the screener (home still jumps to top). The prompt swallows
  // keys and leaves the selection where it was; esc closes it.
  applyKey(state, key('g'), stack);
  assert.ok(state.goto, 'g opens the go-to prompt');
  assert.equal(state.selected, state.screener.rows.length - 1, 'opening the prompt does not move the cursor');
  applyKey(state, key('q'), stack); // swallowed into the prompt, never quits
  assert.equal(state.goto!.input, 'q');
  applyKey(state, key('\x1b'), stack);
  assert.equal(state.goto, null, 'esc closes the prompt');
  applyKey(state, key('\x1b[H'), stack); // home jumps to the top
  assert.equal(state.selected, 0);
  assert.equal(applyKey(state, key('q'), stack), 'quit');
});

test('selection clamps when a filter shrinks the view; open uses the filtered row', () => {
  const state = makeFixtureState({ screen: 'screener', selected: 30 });
  const stack: ScreenKey[] = [];
  applyAction(state, 'filter.edit', stack);
  for (const k of keys('launchpad:pump\r')) applyKey(state, k, stack);
  const view = screenerView(state.screener);
  assert.ok(view.length < state.screener.rows.length);
  assert.equal(state.selected, view.length - 1);
  applyAction(state, 'open', stack);
  assert.equal(state.screen, 'token');
  assert.equal(state.token, view[view.length - 1].fixture);
});

// ---------------------------------------------------------------------------------------------
// rows

test('cleanText drops control/bidi/zero-width characters and boxes wide glyphs', () => {
  assert.equal(cleanText('ab\u0000c‮​d'), 'abcd');
  assert.equal(cleanText('Chiikawa ちいかわ'), 'Chiikawa ▯▯▯▯');
  assert.equal(cleanText('rocket 🚀 coin'), 'rocket ▯ coin');
  assert.equal(cleanText('é'), 'e');
  assert.equal(cleanText('x'.repeat(100), 10).length, 10);
  assert.equal(cleanText(null), '');
});

test('impliedSpark follows the reported deltas and ends at the live price', () => {
  const s = impliedSpark(100, { m5: 0, h1: 10, h6: -20, h24: 50 }, 16)!;
  assert.equal(s.length, 16);
  assert.equal(s[15], 100);
  assert.ok(Math.abs(s[0] - 100 / 1.5) < 1e-9, '24h ago');
  assert.equal(impliedSpark(null, { m5: 1, h1: 1, h6: 1, h24: 1 }), undefined);
  assert.equal(impliedSpark(1, { m5: null, h1: null, h6: null, h24: null }), undefined);
});

// ---------------------------------------------------------------------------------------------
// the feed over the recorded sample (same code path as live, replay transport, no network)

const replayFeed = createReplayFeed(SAMPLE);
const replayRows = await replayFeed.refresh();

test('replay feed: trending discovery + enrichment yields 30 real rows with no live request', () => {
  assert.equal(replayRows.length, 30);
  assert.equal(replayFeed.requests, 0);
  assert.deepEqual(replayFeed.errors, {});
  const st = replayFeed.status();
  assert.equal(st.headerStatus, undefined);
  assert.equal(st.feedLabel, 'dexscreener · jup');
  assert.ok(Object.values(replayFeed.gates()).filter((g) => g.id !== 'bonding' && g.id !== 'snipers' && g.id !== 'bundled').every((g) => g.available));
  assert.equal(replayFeed.gates().snipers.state, 'needs-key');
  // task-1298: bonding progress is served by PumpPortal's create reserves (new pairs); the pump.fun frontend API stays off
  assert.deepEqual(replayFeed.gates().bonding.via, ['pumpportal'], 'pump.fun frontend stays off until D-08; PumpPortal serves bonding');
  assert.equal(replayFeed.refreshedAgo(), '0s');
  for (const r of replayRows) {
    assert.ok(r.mint.length >= 32);
    assert.ok(r.symbol.length > 0 && r.symbol.length <= 12);
    assert.ok(![...r.name].some((ch) => (ch.codePointAt(0) as number) < 0x20), 'no control chars');
    assert.ok(r.sources.includes('dexscreener') || r.sources.includes('jupiter-tokens'));
    assert.equal(r.fixture, undefined);
    assert.equal(r.snipers, null, 'keyless rows never invent forensics');
    assert.equal(r.bundled, null);
  }
  const withHolders = replayRows.filter((r) => r.holders !== null);
  assert.ok(withHolders.length >= 25, 'Jupiter holder counts present');
  assert.ok(replayRows.some((r) => r.holdersChgPct !== null));
  assert.ok(replayRows.every((r) => r.holders24 === null), 'live rows carry the holder change as a percentage only');
  assert.ok(replayRows.some((r) => r.mcapFlagged), 'the sample has a bridged token where sources disagree (ZEC)');
  // the acceptance filter over real rows agrees with the predicate too
  const sc = makeScreenerState('replay', replayRows);
  setFilter(sc, 'vol24 > 250K liq > 50K');
  const byHand = replayRows.filter((r) => r.vol24 !== null && r.vol24 > 250e3 && r.liq !== null && r.liq > 50e3);
  assert.deepEqual(screenerView(sc).map((r) => r.mint), sortRows(byHand, 'vol', 'desc').map((r) => r.mint));
  assert.ok(byHand.length > 0 && byHand.length < replayRows.length);
});

test('feed state renders real rows at 176/120/90 without throwing, with presets gated and the header live', () => {
  const state = makeFeedState(replayFeed, 'replay', { selected: 3, theme: THEMES.midnight });
  assert.equal(state.screener.source, 'replay');
  assert.equal(state.feedLabel, 'dexscreener · jup');
  for (const [w, h] of [[176, 48], [120, 40], [90, 40], [80, 24]] as const) {
    const plain = renderFrame(state, w, h).toPlain();
    const lines = plain.split('\n');
    assert.equal(lines.length, h);
    for (const row of lines) assert.ok([...row].length <= w, `row wider than ${w} at ${w}×${h}`);
    assert.match(lines[0], /◉ live/);
    assert.match(plain, /30 tokens · sorted by vol 24h/);
  }
  const wide = renderFrame(state, 176, 48).toPlain();
  // task-1356 Tier 6: Graduating is now a selectable keyless approximation, so its caption reads 'approx'
  // (not the old 'D-08' pending gate), and the caption renders even though the preset is available.
  assert.match(wide, /Graduating approx/);
  assert.doesNotMatch(wide, /Graduating D-08/, 'the D-08 pending gate is gone; Graduating is a keyless approximation now');
  assert.match(wide, /\$33K\?/, 'flagged mcap carries a ? in the plain render');
  assert.match(wide, /○ snipers needs key/, 'unknown safety checks are never a pass or fail');
  assert.match(wide, /press a for a claude analysis/); // task-1311 (M13): no dangling internal "D-15" ticket
  // the demo-data marker on screens that are still on fixtures
  state.screen = 'newpairs';
  assert.match(renderFrame(state, 120, 40).toPlain().split('\n')[0], /◌ demo data/);
});

test('opening a live row without live bindings never enters the fixture token screen; the notice says so', () => {
  const state = makeFeedState(replayFeed, 'replay', { selected: 0 });
  const stack: ScreenKey[] = [];
  applyAction(state, 'open', stack);
  assert.equal(state.screen, 'screener');
  assert.match(state.screener.notice ?? '', /needs live mode/);
  assert.match(renderFrame(state, 120, 40).toPlain(), /needs live mode/);
  applyAction(state, 'move.down', stack);
  assert.equal(state.screener.notice, null, 'the next key clears the notice');
});

test('preset change on a feed asks for a refresh and re-discovers through the store', async () => {
  const feed = createReplayFeed(SAMPLE);
  await feed.refresh();
  const state = makeFeedState(feed, 'replay');
  const stack: ScreenKey[] = [];
  assert.equal(applyKey(state, key(']'), stack), 'refresh');
  assert.equal(feed.preset, 'runners');
  assert.equal(state.screener.preset, 'runners');
  assert.equal(feed.rows.length, 0, 'rows reset until the refresh lands');
  await feed.refresh();
  syncFeed(state);
  // runners unions trending ∪ organic ∪ recent; the sample only recorded DexScreener for the trending batch,
  // so the extra mints come back Jupiter-only and the DexScreener miss is an error, not a crash
  assert.ok(feed.rows.length > 30, `union of feeds (${feed.rows.length})`);
  assert.ok(feed.errors.dexscreener?.includes('no recorded fixture'));
  assert.doesNotThrow(() => renderFrame(state, 176, 48));
  feed.close();
});

test('live-backed presets fold the extra-mints (PumpPortal) stream into the candidate pool (task-1303)', async () => {
  const FAKE = 'FakeLiveStreamMint11111111111111111111111111';
  // A fresh feed+store per probe: the candidate pool (`seen`) is rebuilt each refresh, so one refresh
  // each keeps this off the feed's TTL/replay-exhaustion semantics.
  async function poolOf(preset: string, extra: string[]): Promise<number> {
    const store = FixtureStore.load(SAMPLE);
    const dl = createDataLayer({ transport: replayTransport(store), buckets: unlimitedBuckets(), disabled: ['pumpfun'] });
    const feed = new ScreenerFeed(dl, { now: () => Date.parse(store.recordedAt as string), wide: true, limit: 30 });
    feed.extraMints = () => extra;
    feed.setPreset(preset as PresetId);
    await feed.refresh();
    const pool = feed.pool;
    feed.close();
    return pool;
  }
  // A non-live preset never consults the stream, even when one is wired.
  assert.equal(await poolOf('trending', [FAKE]), await poolOf('trending', []), 'trending ignores the live stream');
  // A live-backed preset ("New") folds the stream mint into the pool: it is counted in `pool` even
  // when it is too fresh for the REST sources to enrich (it entered `seen`).
  assert.equal(await poolOf('new', [FAKE]), (await poolOf('new', [])) + 1, 'the live stream mint joined the candidate pool');
});

// ---------------------------------------------------------------------------------------------
// degraded sources: holders/org gate off, cells show a dash with a caption, nothing crashes

/** Advance a fake clock until the promise settles (limiter pauses are timers on the fake clock). */
async function drive<T>(clock: FakeClock, p: Promise<T>, stepMs = 500, maxMs = 3_600_000): Promise<T> {
  let settled = false;
  p.then(() => (settled = true), () => (settled = true));
  for (let elapsed = 0; !settled; elapsed += stepMs) {
    if (elapsed > maxMs) throw new Error('drive(): did not settle');
    await clock.advance(stepMs);
  }
  return p;
}

test('Jupiter rate-limited: holders/org columns degrade with a caption, header says so, Retry-After pauses the bucket', async () => {
  const store = FixtureStore.load(SAMPLE);
  const clock = new FakeClock(Date.parse(store.recordedAt ?? '2026-10-06T00:58:56Z'));
  const inner = replayTransport(store);
  const calls: string[] = [];
  // Without Jupiter the discovered mint set differs from the recording, so any DexScreener batch
  // gets the recorded batch (the adapter keys pairs by mint; extras are ignored).
  const batch = store.list().find((e) => e.url.includes('/tokens/v1/solana/')) as { url: string };
  const transport: Transport = async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req.url);
    if (req.url.includes('jup.ag')) return { status: 429, headers: { 'retry-after': '10' }, body: '{"error":"rate limited"}', latencyMs: 3 };
    if (req.url.includes('/tokens/v1/solana/')) return inner({ ...req, url: batch.url });
    return inner(req);
  };
  const dl = createDataLayer({ clock, transport, buckets: unlimitedBuckets(), disabled: ['pumpfun'] });
  const feed = new ScreenerFeed(dl, { now: () => clock.now() });
  const t0 = clock.now();
  const rows = await drive(clock, feed.refresh());
  assert.ok(rows.length >= 10, `DexScreener still fills the table (${rows.length})`);
  assert.ok(rows.every((r) => r.holders === null && r.org === null), 'no holder/organic numbers are invented');
  assert.ok(rows.every((r) => r.sources.length === 1 && r.sources[0] === 'dexscreener'));
  assert.equal(dl.health.state('jupiter-tokens'), 'degraded');
  const g = feed.gates();
  assert.equal(g.holders.available, false);
  assert.equal(g.holders.state, 'degraded');
  assert.equal(g.org.available, false);
  assert.equal(g.vol.available, true);
  assert.equal(feed.status().headerStatus, '◐ degraded: jup');
  // jupiter-price saw one 429 only (its own source entry), so the label may still list jup; tokens is what degraded
  assert.match(feed.status().feedLabel, /^dexscreener/);
  assert.equal(dl.health.state('jupiter-price'), 'ok');
  assert.ok(feed.errors['jupiter-tokens']?.includes('429'));
  assert.ok(clock.now() - t0 >= 10_000, 'the second Jupiter call waited for Retry-After');
  assert.equal(calls.filter((u) => u.includes('jup.ag')).length, 3, 'trending, search, price: one each, no retry storm');
  assert.equal(gateCaption(g, ['holders', 'org', 'vol']), 'holders, org: degraded');

  const state = makeFeedState(feed, 'live', { selected: 2, calm: true });
  for (const [w, h] of [[176, 48], [120, 40], [90, 40]] as const) {
    const plain = renderFrame(state, w, h).toPlain();
    assert.equal(plain.split('\n').length, h);
    assert.match(plain, /◐ degraded: jup/);
    if (w >= 120) assert.match(plain, /holders, org: degraded/);
  }
  const wide = renderFrame(state, 176, 48).toPlain();
  const headerLine = wide.split('\n').find((l) => l.includes('HOLDERS')) as string;
  const body = wide.split('\n').filter((l) => /^│▎? *\d+ /.test(l));
  assert.ok(body.length >= 10);
  const col = headerLine.indexOf('HOLDERS');
  for (const line of body) assert.equal(line.slice(col, col + 7).trim(), '—', `holders cell is a dash: ${line.slice(col, col + 7)}`);
  assert.match(wide, /HOLDERS[\s\S]*?— degraded[\s\S]*?ORGANIC\s+TOP 10[\s\S]*?— degraded\s+— degraded/, 'spotlight holders/organic/top-10 read degraded');
  feed.close();
});

test('request budget exhausted: the feed degrades instead of crashing', async () => {
  const store = FixtureStore.load(SAMPLE);
  const inner = replayTransport(store);
  let n = 0;
  const transport: Transport = async (req) => { if (++n > 2) throw new Error('recorder request budget exhausted (2)'); return inner(req); };
  const dl = createDataLayer({ transport, buckets: unlimitedBuckets(), disabled: ['pumpfun'] });
  const feed = new ScreenerFeed(dl, { now: () => Date.parse(store.recordedAt as string) });
  const rows = await feed.refresh();
  assert.ok(Object.keys(feed.errors).length > 0);
  assert.ok(rows.length >= 0);
  assert.doesNotThrow(() => renderFrame(makeFeedState(feed, 'live'), 120, 40));
  feed.close();
});

test.after(() => replayFeed.close());
