// task-1311 regression tests for the v0.1 QA BLOCKERS/MAJORs (internal QA evidence, not published: dexterm-v01-qa-report.md).
// Each test names its QA id. The interactive blockers (B1, B3, DEFECT 1, DEFECT 2) drive the REAL binary
// over a pty and run in the serial lane: serial/qa-1311-pty.test.ts (task-1424). The rest (B2, B5, M4, M5,
// M8, M9, M12, M13) are deterministic in-process checks on the same code paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyAction, copyToClipboard } from '../src/main.ts';
import { makeFixtureState, syncAnalyst, pinNewpairsSelection, renderFrame, type AppState } from '../src/state.ts';
import { createReplayFeed, createLiveFeed, unlimitedBuckets } from '../src/feed.ts';
import { makeFeedState } from '../src/state.ts';
import { LiveContext, TokenLive } from '../src/live/index.ts';
import { screenerView } from '../src/screener/view.ts';
import { presetSpec, bakedFilter } from '../src/screener/presets.ts';
import { fromFixture } from '../src/screener/rows.ts';
import { makeFixtures } from '../src/fixtures.ts';
import { AnalystSession } from '../src/analyst/session.ts';
import { renderAnalystSession } from '../src/screens/analyst-session.ts';
import { Canvas, THEMES, type ScreenKey } from '@dexterm/tui';
import { createDataLayer, FakeClock, type HttpRequest, type HttpResponse } from '@dexterm/data';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(here, '..', '..', 'data', 'fixtures', 'live-sample.json');

// ---------------------------------------------------------------- B2
test('QA B2: `i` focuses the chat input on the token screen (press-i-to-ask replaces press-4)', () => {
  const s = makeFixtureState({ screen: 'token', selected: 0 });
  const stack: ScreenKey[] = [];
  assert.notEqual(s.aiFocused, true);
  applyAction(s, 'input.focus', stack);
  assert.equal(s.aiFocused, true, '`i` focuses the input');
  assert.equal(s.aiOpen, true, 'the analyst panel is shown so there is somewhere to type');
});

// ---------------------------------------------------------------- B5
test('QA B5: `y` copies the full contract address and confirms', () => {
  const s = makeFixtureState({ screen: 'token', selected: 0 });
  const mint = s.token!.mint;
  assert.ok(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint), 'a full base58 mint');
  applyAction(s, 'copy.ca', []);
  assert.equal(s.pendingCopy, mint, 'the full mint is queued for the clipboard (the loop runs pbcopy/xclip/clip)');
  assert.match(s.screener.notice ?? '', /copied contract address/, 'a confirmation is shown');
  assert.doesNotThrow(() => copyToClipboard(mint), 'the clipboard helper never throws, even with no tool present');
});

// ---------------------------------------------------------------- M4
test('QA M4: the live screener defaults to the trench feed; the baked filter hides blue chips/stocks/stables', () => {
  const feed = createLiveFeed({ dbPath: undefined });
  try { assert.equal(feed.preset, 'trench', 'the live app opens on the trench feed'); } finally { feed.close(); }

  const spec = presetSpec('trench');
  assert.ok(spec, 'the trench preset exists and is reachable in the feed switcher');
  const f = bakedFilter(spec!);
  assert.ok(f, 'the trench feed has a baked filter');
  const base = fromFixture(makeFixtures(7).tokens[0]);
  const blueChip = { ...base, symbol: 'ORCA', verified: true, liq: 5_000_000 };
  const stock = { ...base, symbol: 'NVDAx', verified: true, liq: 800_000 };
  const memecoin = { ...base, symbol: 'WIF', verified: false, liq: 50_000 };
  const dust = { ...base, symbol: 'DEAD', verified: false, liq: 200 };
  assert.equal(f!.predicate(blueChip), false, 'a verified blue chip is hidden');
  assert.equal(f!.predicate(stock), false, 'a tokenized stock is hidden');
  assert.equal(f!.predicate(memecoin), true, 'an unverified memecoin over the floor is kept');
  assert.equal(f!.predicate(dust), false, 'dust below the liquidity floor is hidden');
});

// ---------------------------------------------------------------- M5
test('QA M5: opening a token never starts a paid analyst run; each token keeps its own chat', async () => {
  const feed = createReplayFeed(SAMPLE);
  await feed.refresh();
  const state = makeFeedState(feed, 'replay', { selected: 0 });
  state.live = new LiveContext(feed.dl, { mode: 'replay' });
  const stack: ScreenKey[] = [];
  // pick a real (non-fixture) row so `open` takes the live path
  const idx = screenerView(state.screener).findIndex((r) => !(r as { fixture?: unknown }).fixture);
  state.selected = Math.max(0, idx);
  applyAction(state, 'open', stack);
  assert.equal(state.screen, 'token', 'the token opened');
  assert.equal(state.pendingAnalyst ?? null, null, 'no paid dossier is queued on ⏎ (QA M5)');

  // moving between tokens restores the token's own conversation instead of cancelling it
  const mintA = state.live.token?.view.mint ?? 'A';
  const sessionA = { marker: 'A' } as unknown as NonNullable<AppState['analyst']>;
  state.analystByMint!.set(mintA, sessionA);
  state.analyst = null;
  syncAnalyst(state);
  assert.equal(state.analyst, sessionA, "returning to a token restores that token's chat");
  state.live.close();
  feed.close();
});

// ---------------------------------------------------------------- M8
test('QA M8: the New pairs highlight follows the picked coin by mint when new creates insert on top', () => {
  // the cursor is on mint "B"; a new coin lands at the top (newest-first), shifting every index.
  let list = [{ mint: 'X' }, { mint: 'A' }, { mint: 'B' }];
  const s = { screen: 'newpairs', selected: 2, selectedMint: 'B', live: { newpairs: { list: () => list } } } as unknown as AppState;
  pinNewpairsSelection(s);
  assert.equal(s.selected, 2, 'pinned on B');
  list = [{ mint: 'NEW' }, { mint: 'X' }, { mint: 'A' }, { mint: 'B' }]; // a create inserted at the top
  pinNewpairsSelection(s);
  assert.equal(s.selected, 3, 'the highlight tracked the mint to its new index, not the stale row 2');
  assert.equal(list[s.selected].mint, 'B', 'still on the coin the user picked');
});

// ---------------------------------------------------------------- M12
test('QA M12: a long analyst answer is not cut at 16 lines — it scrolls, and reveals in full', () => {
  const sess = new AnalystSession({ skill: 'token-dossier', screenState: {} }, () => {});
  sess.status = 'done';
  sess.doneAt = Date.now();
  sess.verdict = null;
  sess.summary = Array.from({ length: 40 }, (_, i) => `answer line number ${i + 1} of forty`);
  assert.equal(sess.summary.length, 40, 'the full answer is kept (no slice(0,16))');

  const draw = (scroll: number): string => {
    const c = new Canvas(64, 22, THEMES.midnight);
    c.fill(0, 0, 64, 22, ' ', { bg: THEMES.midnight.bg });
    renderAnalystSession(c, 0, 0, 64, 22, sess, { frame: 0, code: '0123456789abcdef', calm: true, scroll, revealAll: true });
    return c.toPlain();
  };
  const top = draw(0);
  assert.match(top, /answer line number 1 of forty/, 'the top of the answer shows, fully revealed');
  assert.match(top, /more .* j\/k/, 'a scroll marker tells the user there is more');
  assert.doesNotMatch(top, /line number 40 of forty/, 'the last line is below the fold at scroll 0');
  const bottom = draw(40);
  assert.match(bottom, /answer line number 40 of forty/, 'scrolling reaches the end of the answer');
});

// ---------------------------------------------------------------- M13
test('QA M13: in live mode the Analyst tab shows no canned demo conversation or 2024 fixture tickers', async () => {
  const feed = createReplayFeed(SAMPLE);
  await feed.refresh();
  const state = makeFeedState(feed, 'replay', { screen: 'analyst' });
  state.live = new LiveContext(feed.dl, { mode: 'replay' });
  const out = renderFrame(state, 176, 48).toPlain();
  for (const fake of ['SIGMA', 'GOAT', 'CHILLGUY', 'NEIRO', 'screen for tokens under $5M']) {
    assert.doesNotMatch(out, new RegExp(fake), `the demo artefact "${fake}" must not sit next to live data`);
  }
  assert.match(out, /No conversation yet/, 'the live tab explains how to start a real conversation');
  // the screener spotlight no longer dangles an internal "D-15" ticket at the user
  state.screen = 'screener';
  assert.doesNotMatch(renderFrame(state, 176, 48).toPlain(), /D-15/);
  feed.close();
});

// ---------------------------------------------------------------- M9
test('QA M9: a fresh pair with no indexed pool keeps the mcap known from the new-pairs stream', async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const MINT = 'FreshPumpMintaaaaaaaaaaaaaaaaaaaaaaaaaaapump';
  const json = (status: number, body: unknown): HttpResponse => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), latencyMs: 1 });
  const jup = { id: MINT, name: 'Fresh', symbol: 'FRESH', decimals: 6, launchpad: 'pump.fun', isVerified: false, usdPrice: null, mcap: null, fdv: null, liquidity: null };
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    const u = new URL(req.url);
    if (u.pathname.startsWith('/tokens/v1/solana/')) return json(200, []);   // no DexScreener pool yet
    if (u.pathname === '/tokens/v2/search') return json(200, [jup]);          // Jupiter sees the mint, no market
    if (u.pathname === '/price/v3') return json(200, {});
    return json(404, {});
  };
  const dl = createDataLayer({ clock, transport, buckets: unlimitedBuckets() });
  // seeded from the New pairs stream: mcap/price are known even before any pool exists
  const live = new TokenLive(dl, { mint: MINT, symbol: 'FRESH', name: 'Fresh', launchpad: 'pump.fun', mcap: 3000, price: 0.0000031, ageMin: 0.5 }, { now: () => clock.now() });
  const p = live.load();
  for (let i = 0; i < 30 && live.view.updatedAt === null; i++) await clock.advance(100);
  await p;
  assert.equal(live.view.mcap, 3000, 'the known mcap is preserved, not blanked to —');
  assert.equal(live.view.price, 0.0000031, 'the known price is preserved');
  dl.close();
});
