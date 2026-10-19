// Snapshot tests: the five screens at 176/120/90 columns must render exactly like the goldens in
// test/snapshots/. Goldens are the CALM render (effects off): the text is the data and the chrome,
// nothing frame-dependent; the effects have their own determinism and hard-cell tests (fx.test.ts).
// When dexterm/prototype-v2 sits next to the repo, the four fixture screens are compared byte for
// byte against `prototype-v2 --calm --theme midnight` (plain and 24-bit ANSI) and the screener's
// column set against both prototypes; from a `git archive` copy those parts are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { THEMES } from '@dexterm/tui';
import { makeFixtureState, makeFeedState, createReplayFeed, renderFrame } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const snapDir = resolve(here, 'snapshots');
const protoV2 = resolve(here, '..', '..', '..', '..', 'prototype-v2', 'dexterm.mjs');
const protoV1 = resolve(here, '..', '..', '..', '..', 'prototype', 'dexterm.mjs');
const hasV2 = existsSync(protoV2);
const hasV1 = existsSync(protoV1);
const samplePath = resolve(here, '..', '..', 'data', 'fixtures', 'live-sample.json');

// The screener on the recorded data-store sample (D-03): goldens from this renderer, pinned to the
// recording's clock, so a layout regression on real-shaped rows shows up like a prototype one.
const replayFeed = createReplayFeed(samplePath);
await replayFeed.refresh();
const LIVE_CASES = ([[176, 48], [120, 40], [90, 40]] as const).map(([width, height]) => ({ width, height, selected: 3, name: `screener-live-${width}x${height}` }));

for (const c of LIVE_CASES) {
  test(`snapshot ${c.name} (data store replay) matches the committed golden`, () => {
    const want = readFileSync(resolve(snapDir, `${c.name}.txt`), 'utf8').replace(/\n$/, '');
    const got = renderFrame(makeFeedState(replayFeed, 'replay', { selected: c.selected, theme: THEMES.midnight, calm: true }), c.width, c.height).toPlain();
    assert.equal(got, want);
    for (const row of got.split('\n')) assert.ok([...row].length <= c.width, `row wider than ${c.width}`);
    assert.equal(got.split('\n').length, c.height);
  });
}
test.after(() => replayFeed.close());

type Screen = 'screener' | 'token' | 'newpairs' | 'watchlist' | 'analyst';
interface Case { screen: Screen; width: number; height: number; selected: number; name: string }

const CASES: Case[] = [];
for (const screen of ['screener', 'token', 'newpairs', 'watchlist', 'analyst'] as const) {
  const selected = screen === 'screener' || screen === 'token' ? 3 : screen === 'analyst' ? 0 : 1;
  for (const [width, height] of [[176, 48], [120, 40], [90, 40]] as const) {
    CASES.push({ screen, width, height, selected, name: `${screen}-${width}x${height}` });
  }
}

function renderOurs(c: Case, ansi = false): string {
  const state = makeFixtureState({ screen: c.screen, selected: c.selected, theme: THEMES.midnight, calm: true });
  const canvas = renderFrame(state, c.width, c.height);
  return ansi ? canvas.toAnsi({ depth: 'truecolor' }) : canvas.toPlain();
}

function renderPrototype(entry: string, c: Case, ansi = false, extra: string[] = []): string {
  const args = [entry, '--screen', c.screen, '--width', String(c.width), '--height', String(c.height), '--selected', String(c.selected), '--theme', 'midnight', ...extra];
  // prototype-v2 detects the colour mode from the environment (none on a pipe without COLORTERM): force 24-bit
  if (ansi) { if (entry === protoV2) args.push('--color', 'truecolor'); } else args.push('--plain');
  return execFileSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' } }).replace(/\n$/, '');
}

for (const c of CASES) {
  test(`snapshot ${c.name} matches the committed golden`, () => {
    const want = readFileSync(resolve(snapDir, `${c.name}.txt`), 'utf8').replace(/\n$/, '');
    const got = renderOurs(c);
    assert.equal(got, want);
    // every row fits the frame
    for (const row of got.split('\n')) assert.ok([...row].length <= c.width, `row wider than ${c.width}: ${row.length}`);
    assert.equal(got.split('\n').length, c.height);
  });
}

test('goldens exist for all 15 cases', () => {
  for (const c of CASES) assert.ok(existsSync(resolve(snapDir, `${c.name}.txt`)), c.name);
});

// midnight's `ai` colour (#a78bfa) as the prototype emits it in 24-bit SGR
const AI_SGR = '38;2;167;139;250';

// task-1348: prototype-v2's trade-moment pass (task-1291) added a `5 Positions` tab and an `x buy ticket` footer.
// The app shipped paper trading differently on purpose (task-1310: `B`/`S` open the ticket, `P` opens positions,
// collision-free with the existing keys). In plain text the tab label is blanked and the rest of the tab strip
// must still match; the token footer (different key hints) is skipped. In ANSI both rows are skipped.
const POSITIONS_TAB = '5 Positions';
const departureRows = (protoPlain: string[]): Set<number> => new Set(protoPlain.flatMap((row, y) => (row.includes(POSITIONS_TAB) || row.includes('x  buy ticket') ? [y] : [])));
const blankTab = (row: string): string => row.replace(POSITIONS_TAB, ' '.repeat(POSITIONS_TAB.length));

test('prototype-v2 parity: token / new pairs / watchlist / analyst match `--calm --theme midnight` (plain + 24-bit ANSI)', { skip: hasV2 ? false : 'dexterm/prototype-v2 not present (archive copy)' }, () => {
  for (const c of CASES.filter((k) => k.screen !== 'screener')) {
    const oursPlain = renderOurs(c).split('\n');
    const theirsPlain = renderPrototype(protoV2, c, false, ['--calm']).split('\n');
    assert.equal(oursPlain.length, theirsPlain.length, `${c.name} plain height`);
    const skip = departureRows(theirsPlain);
    for (const y of skip) assert.ok(y === 0 || y === theirsPlain.length - 1, `${c.name}: trade departure on row ${y}, expected the tab strip or the footer`);
    const footer = theirsPlain.length - 1;
    const keep = (_: string, y: number): boolean => !(skip.has(y) && y === footer);
    assert.deepEqual(oursPlain.filter(keep), theirsPlain.map((row, y) => (y === 0 ? blankTab(row) : row)).filter(keep), `${c.name} plain`);
    const ours = renderOurs(c, true).split('\n').filter((_, y) => !skip.has(y));
    const theirs = renderPrototype(protoV2, c, true, ['--calm']).split('\n').filter((_, y) => !skip.has(y));
    assert.equal(ours.length, theirs.length);
    // the coral rule (design note, 2026-10-06) deliberately departs from prototype-v2 on the analyst's
    // lines: tool-call lines take coral, the answer body takes normal text, only the verdict stays coral.
    // Every other row must be byte-identical; a differing row must involve the analyst colour on one side.
    const differing = ours.map((row, y) => (row === theirs[y] ? -1 : y)).filter((y) => y >= 0);
    for (const y of differing) assert.ok(ours[y].includes(AI_SGR) || theirs[y].includes(AI_SGR), `${c.name} ansi row ${y} differs outside the analyst's lines`);
    if (c.screen === 'newpairs' || c.screen === 'watchlist') assert.deepEqual(differing, [], `${c.name} ansi`);
    else assert.ok(differing.length <= 12, `${c.name} ansi: ${differing.length} analyst rows differ`);
  }
});

/** The table header line, cut before the side panel so spotlight text is not compared. */
function tableHeader(txt: string): string {
  const l = txt.split('\n').find((x) => /TOKEN/.test(x) && /(PRICE|MCAP)/.test(x)) || '';
  const m = l.indexOf('│ │');
  return (m >= 0 ? l.slice(0, m) : l).replace(/\s+$/, '');
}

test('screener column set at 176 / 120 / 90 matches both prototypes (D-03 owns the rest of the screen)', { skip: hasV1 || hasV2 ? false : 'no prototype present (archive copy)' }, () => {
  for (const c of CASES.filter((k) => k.screen === 'screener')) {
    const ours = tableHeader(renderOurs(c));
    assert.match(ours, /TOKEN/);
    if (hasV1) assert.equal(ours, tableHeader(renderPrototype(protoV1, c)), `${c.name} vs prototype`);
    if (hasV2) assert.equal(ours, tableHeader(renderPrototype(protoV2, c, false, ['--calm'])), `${c.name} vs prototype-v2`);
  }
});

test('themes render the same text in every theme (color-only difference)', () => {
  const c = CASES[0];
  const plain = renderOurs(c);
  for (const theme of [THEMES.cyberspace, THEMES.ember, THEMES.paper]) {
    const state = makeFixtureState({ screen: c.screen, selected: c.selected, theme, calm: true });
    const got = renderFrame(state, c.width, c.height).toPlain();
    // the footer prints the theme name, so compare everything above it
    assert.equal(got.split('\n').slice(0, -1).join('\n'), plain.split('\n').slice(0, -1).join('\n'));
  }
});
