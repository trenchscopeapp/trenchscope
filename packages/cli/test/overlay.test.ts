// First-run WELCOME and the `?` HELP overlay (task-1305). These are drawn last, over the live screen,
// and are the app's only self-documentation — so the tests assert the actual rendered text: the six
// getting-around hints, every screen's key list, and the safety stance. They also pin the two
// invariants that keep the overlay from ever breaking a terminal: it fits the frame width, and it
// degrades (draws nothing, never throws) when the terminal is too small.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_KEYMAP, THEMES, type ScreenKey } from '@dexterm/tui';
import { makeFixtureState, renderFrame, helpRows, type AppState } from '../src/index.ts';

function renderOverlayPlain(screen: ScreenKey, overlay: 'welcome' | 'help', w: number, h: number): string {
  const state: AppState = makeFixtureState({ screen, selected: 3, theme: THEMES.midnight, calm: true });
  state.overlay = overlay;
  return renderFrame(state, w, h).toPlain();
}

function assertFitsFrame(out: string, w: number, h: number) {
  const rows = out.split('\n');
  assert.equal(rows.length, h, `expected ${h} rows`);
  for (const row of rows) assert.ok([...row].length <= w, `a row is wider than ${w}: "${row}"`);
}

test('welcome names the app, lists the six getting-around hints, and states the safety stance', () => {
  const out = renderOverlayPlain('screener', 'welcome', 120, 40);
  assert.match(out, /WELCOME TO TRENCHSCOPE/);
  assert.match(out, /read-only/i);
  // the safety promises
  assert.match(out, /never signs/i);
  assert.match(out, /financial advice/i);
  // the six hints each surface their key and their gist
  assert.match(out, /1-4/);
  assert.match(out, /switch screens/i);
  assert.match(out, /j\/k/);
  assert.match(out, /open a token/i);
  assert.match(out, /filter/i);
  assert.match(out, /ask Claude/i);
  assert.match(out, /every key/i); // the `?` hint
  assert.match(out, /quit/i);
  assertFitsFrame(out, 120, 40);
});

test('help on the screener lists every bound key for that screen plus the loop-handled extras', () => {
  const out = renderOverlayPlain('screener', 'help', 120, 40);
  assert.match(out, /KEYS — Screener/);
  // a sample across global + screener bindings
  for (const label of ['quit', 'screener', 'new pairs', 'watchlist', 'ask claude', 'filter', 'sort', 'preset', 'refresh', 'help']) {
    assert.ok(out.includes(label), `help should list "${label}"`);
  }
  // the extras handled in the interactive loop, not the keymap
  assert.match(out, /calm mode/i);
  // the demo keys show because fixtures are the data source
  assert.match(out, /demo:/i);
  // the safety footer is always present
  assert.match(out, /read-only · no keys · no trades · not financial advice/);
  assertFitsFrame(out, 120, 40);
});

test('help reflects per-screen overrides: on the token screen the number keys are timeframes, not screen jumps', () => {
  const rows = helpRows('token', false);
  const byLabel = (l: string) => rows.find((r) => r.label === l);
  // the timeframe labels are present and attributed to the number keys
  assert.ok(byLabel('1m'), 'token help should list the 1m timeframe');
  assert.ok(byLabel('1d'), 'token help should list the 1d timeframe');
  assert.equal(byLabel('1m')!.keys, '1');
  // the global "screener"/"new pairs" jumps are shadowed on this screen, so they must NOT appear
  assert.equal(byLabel('screener'), undefined, 'key 1 is a timeframe on the token screen, not "screener"');
  assert.equal(byLabel('new pairs'), undefined);
  // but screen-independent verbs survive
  assert.ok(byLabel('quit'));
});

test('help is produced for every screen and always carries the safety footer', () => {
  for (const screen of ['screener', 'token', 'newpairs', 'watchlist', 'analyst'] as const) {
    const out = renderOverlayPlain(screen, 'help', 120, 40);
    assert.match(out, /KEYS — /, `${screen} help title`);
    assert.match(out, /not financial advice/, `${screen} safety footer`);
    assertFitsFrame(out, 120, 40);
  }
});

test('helpRows never duplicates an action and the analyst screen explains the typing capture', () => {
  const analyst = helpRows('analyst', false);
  assert.ok(analyst.some((r) => /ask a follow-up/i.test(r.label)), 'analyst help explains typing');
  // the keymap-derived rows (everything before the OVERLAY_HINTS) carry no duplicate label+keys pair
  const seen = new Set<string>();
  for (const r of analyst) {
    const sig = `${r.keys}::${r.label}`;
    assert.ok(!seen.has(sig), `duplicate help row ${sig}`);
    seen.add(sig);
  }
});

test('the overlay fits a range of terminal sizes and degrades gracefully when tiny', () => {
  for (const [w, h] of [[176, 48], [100, 36], [80, 24], [60, 20]] as const) {
    const welcome = renderOverlayPlain('screener', 'welcome', w, h);
    assertFitsFrame(welcome, w, h);
    const help = renderOverlayPlain('screener', 'help', w, h);
    assertFitsFrame(help, w, h);
  }
  // a terminal too small for any card must still render a full frame (card() returns null, no throw)
  const tiny = renderOverlayPlain('screener', 'welcome', 20, 8);
  assertFitsFrame(tiny, 20, 8);
});

test('the keymap has a single ? binding for help so the overlay toggle is unambiguous', () => {
  const help = DEFAULT_KEYMAP.bindings.filter((b) => b.action === 'help.toggle');
  assert.equal(help.length, 1);
  assert.deepEqual(help[0].keys, ['?']);
});
