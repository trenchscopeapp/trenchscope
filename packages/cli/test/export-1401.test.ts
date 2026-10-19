import { posixPermissions } from '../../../scripts/test-support.ts';
// task-1401 EXPORT / SHARE: `E` renders the current view to a PNG + a text report in ~/.dexterm/exports with the
// data ages and the LIVE / SAMPLE / REPLAY label. Offline: fixtures, the recorded replay sample, temp dirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { Canvas, rasterizeCanvas, glyphBits, DEFAULT_KEYMAP, parseKeys, THEMES } from '@dexterm/tui';
import { decodePng } from '@dexterm/data';
import {
  composeExportCanvas, renderExportPng, renderExportText, writeExport, exportViewFor, renderCalmFrame, dataLabelOf,
  tokenAges, tokenReport, fmtAge, canvasText, LABEL_TEXT, type ExportView,
} from '../src/export.ts';
import { applyAction, main } from '../src/main.ts';
import { makeFixtureState, makeFeedState } from '../src/state.ts';
import { createReplayFeed } from '../src/feed.ts';
import { LiveContext } from '../src/live/index.ts';
import { emptyView } from '../src/live/token.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(here, '..', '..', 'data', 'fixtures', 'live-sample.json');
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const NOW = Date.UTC(2026, 9, 16, 5, 0, 0);
const theme = THEMES.cyberspace;
const tmp = () => mkdtempSync(join(tmpdir(), 'dexterm-export-'));

const px = (img: { w: number; rgba: Uint8Array }, x: number, y: number): [number, number, number] => {
  const i = (y * img.w + x) * 4; return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]];
};

test('font: every printable ASCII character has a glyph', () => {
  for (let c = 0x21; c <= 0x7e; c++) assert.ok(glyphBits(String.fromCharCode(c)), `missing glyph for ${String.fromCharCode(c)}`);
});

test('font: a subscript digit is a small low glyph, never a full-size digit ($0.0₅31 must not read $0.0531); accented letters fall back to the base letter', () => {
  const five = glyphBits('5')!, sub = glyphBits('₅')!, sup = glyphBits('⁵')!;
  assert.notDeepEqual(sub, five);
  const rowInk = (b: Uint8Array, y: number) => [0, 1, 2, 3, 4].some((x) => b[y * 5 + x] === 1);
  for (const y of [0, 1, 2, 3]) assert.ok(!rowInk(sub, y), `subscript row ${y} is empty`);
  for (const y of [5, 6, 7, 8]) assert.ok(!rowInk(sup, y), `superscript row ${y} is empty`);
  const c = new Canvas(2, 1, theme);
  c.put(0, 0, 'é', { fg: '#ffffff', bg: '#000000' }); c.put(1, 0, 'e', { fg: '#ffffff', bg: '#000000' });
  const img = rasterizeCanvas(c, { cellW: 6, cellH: 10, scale: 1 });
  for (let y = 0; y < 10; y++) for (let x = 0; x < 6; x++) assert.deepEqual(px(img, x, y), px(img, x + 6, y), 'é draws as e');
});

test('rasterizeCanvas: cell grid, background, text ink, joined box lines, blocks, braille and a visible fallback box', () => {
  const c = new Canvas(6, 2, theme);
  c.fill(0, 0, 6, 2, ' ', { bg: '#000000' });
  c.put(0, 0, 'A', { fg: '#ffffff', bg: '#000000' });
  c.put(1, 0, '─', { fg: '#ff0000', bg: '#000000' });
  c.put(2, 0, '█', { fg: '#00ff00', bg: '#000000' });
  c.put(3, 0, '⣿', { fg: '#0000ff', bg: '#000000' });
  c.put(4, 0, 'ア', { fg: '#ffffff', bg: '#000000' }); // no glyph → hollow box, never dropped
  c.put(5, 1, ' ', { bg: '#123456' });
  const img = rasterizeCanvas(c, { cellW: 12, cellH: 24, scale: 2 });
  assert.equal(img.w, 72); assert.equal(img.h, 48);
  assert.deepEqual(px(img, 66, 36), [0x12, 0x34, 0x56], 'cell background');
  let ink = 0; for (let y = 0; y < 24; y++) for (let x = 0; x < 12; x++) if (px(img, x, y)[0] === 255) ink++;
  assert.ok(ink > 40, `the A has ink (${ink} px)`);
  assert.deepEqual(px(img, 12, 12), [255, 0, 0], 'horizontal line reaches the left edge at mid-height');
  assert.deepEqual(px(img, 23, 12), [255, 0, 0], '…and the right edge, so it joins the next cell');
  assert.deepEqual(px(img, 24, 0), [0, 255, 0], 'full block fills the cell'); assert.deepEqual(px(img, 35, 23), [0, 255, 0]);
  let dots = 0; for (let y = 0; y < 24; y++) for (let x = 36; x < 48; x++) if (px(img, x, y)[2] === 255) dots++;
  assert.ok(dots > 8, 'braille dots drawn');
  let tofu = 0; for (let y = 0; y < 24; y++) for (let x = 48; x < 60; x++) if (px(img, x, y)[0] === 255) tofu++;
  assert.ok(tofu > 10, 'an unknown glyph draws a visible box');
});

function view(label: ExportView['label'], canvas?: Canvas): ExportView {
  const c = canvas ?? new Canvas(80, 10, theme);
  if (!canvas) { c.fill(0, 0, 80, 10, ' ', { bg: theme.bg }); c.text(2, 2, 'PRICE $0.0123', { fg: theme.text }); }
  return {
    kind: 'token', title: 'TOKEN · $ABC', mint: BONK, label, canvas: c,
    ages: [{ name: 'market', source: 'ds+jup', ageSec: 4 }, { name: 'rugcheck', source: null, ageSec: null, state: 'unavailable (HTTP 503)' }],
    report: ['price       $0.0123'],
  };
}

test('composeExportCanvas: header (title + label), the view untouched, footer with every data age and the local-only note', () => {
  for (const label of ['live', 'sample', 'replay'] as const) {
    const v = view(label);
    const c = composeExportCanvas(v, NOW);
    const lines = canvasText(c);
    assert.match(lines[0], /trenchscope export · TOKEN · \$ABC/);
    assert.ok(lines[0].includes(LABEL_TEXT[label]), `${label}: header carries the label`);
    assert.equal(lines[3], canvasText(v.canvas)[2], 'the view is copied as is, one row down');
    const foot = lines.slice(v.canvas.h + 1).join('\n');
    assert.ok(foot.includes(LABEL_TEXT[label]), 'footer repeats the label');
    assert.match(foot, /market 4s/); assert.match(foot, /rugcheck unavailable \(HTTP 503\)/);
    assert.match(foot, /nothing was uploaded/);
  }
});

test('renderExportPng decodes back to the framed size; renderExportText carries contract, label, ages and the body', () => {
  const v = view('sample');
  const png = renderExportPng(v, NOW, { cellW: 6, cellH: 12, scale: 1 });
  const img = decodePng(png);
  const framed = composeExportCanvas(v, NOW);
  assert.equal(img.w, framed.w * 6); assert.equal(img.h, framed.h * 12);
  const t = renderExportText(v, NOW);
  assert.match(t, new RegExp(`contract    ${BONK}`));
  assert.match(t, /data        ◌ SAMPLE DATA · not real prices/);
  assert.match(t, /market\s+4s\s+ds\+jup/); assert.match(t, /rugcheck\s+unavailable \(HTTP 503\)/);
  assert.match(t, /price {7}\$0\.0123/); assert.match(t, /Nothing was uploaded/);
  assert.match(renderExportText(view('replay'), NOW), /data ages \(on the replay clock\)/);
  assert.equal(fmtAge(4), '4s'); assert.equal(fmtAge(125), '2m'); assert.equal(fmtAge(7300), '2h'); assert.equal(fmtAge(null), '—');
});

test('writeExport: PNG + TXT under DEXTERM_HOME/exports, private file modes, nothing else written', async (t) => {
  const home = tmp();
  try {
    const r = writeExport(view('live'), { now: NOW, env: { DEXTERM_HOME: home }, raster: { cellW: 6, cellH: 12, scale: 1 } });
    assert.equal(dirname(r.png), join(home, 'exports'));
    assert.match(r.png, /dexterm-token-DezXAZ-\d{8}-\d{6}\.png$/);
    assert.deepEqual(readdirSync(join(home, 'exports')).sort(), [r.png, r.txt].map((p) => basename(p)).sort());
    await posixPermissions(t, () => { assert.equal(statSync(r.png).mode & 0o777, 0o600); assert.equal(statSync(r.txt).mode & 0o777, 0o600); });
    assert.ok(decodePng(readFileSync(r.png)).w > 0);
    assert.match(readFileSync(r.txt, 'utf8'), /● LIVE DATA/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the E key: bound on every screen, sets pendingExport; renderCalmFrame restores effects, overlay and prompt', () => {
  for (const screen of ['screener', 'newpairs', 'watchlist', 'token', 'analyst', 'positions']) assert.equal(DEFAULT_KEYMAP.resolve(parseKeys('E')[0], screen), 'export.view', screen);
  const state = makeFixtureState();
  applyAction(state, 'export.view', []);
  assert.equal(state.pendingExport, true);
  state.overlay = 'help'; state.goto = { input: 'abc', notice: null };
  const before = state.vfx.intensity;
  const c = renderCalmFrame(state, 120, 40);
  assert.equal(state.vfx.intensity, before); assert.equal(state.overlay, 'help'); assert.deepEqual(state.goto, { input: 'abc', notice: null });
  assert.doesNotMatch(canvasText(c).join('\n'), /paste a contract address|go to coin/i, 'no prompt in the export');
});

test('exportViewFor: fixtures are SAMPLE with a sample-data age line; a replay token view gets one age per panel', async () => {
  const s = makeFixtureState({ screen: 'token' });
  const fv = exportViewFor(s, 120, 40, NOW);
  assert.equal(fv.label, 'sample'); assert.equal(dataLabelOf(s), 'sample');
  assert.deepEqual(fv.ages, [{ name: 'all panels', source: 'seeded fixtures', ageSec: null, state: 'sample data' }]);
  const feed = createReplayFeed(SAMPLE);
  await feed.refresh();
  const state = makeFeedState(feed, 'replay', { screen: 'token' });
  state.live = new LiveContext(feed.dl, { mode: 'replay' });
  try {
    const t = state.live.openToken({ mint: BONK, symbol: 'Bonk', name: 'Bonk', launchpad: 'unknown' });
    await t.load();
    const v = exportViewFor(state, 140, 44, Date.now());
    assert.equal(v.label, 'replay'); assert.equal(v.kind, 'token'); assert.equal(v.mint, BONK);
    assert.deepEqual(v.ages.map((a) => a.name), ['market', 'candles', 'authorities', 'holders', 'rugcheck', 'goplus', 'trades']);
    for (const a of v.ages) assert.ok(a.ageSec !== null || (a.state && a.state.length), `${a.name}: an age or a reason`);
    assert.ok(v.report.some((l) => l.startsWith('price')));
  } finally { state.live.close(); feed.close(); }
});

test('tokenAges / tokenReport: per-panel fetch ages, unavailable reasons, model outputs labelled', () => {
  const v = emptyView({ mint: BONK, symbol: 'BONK\u0007', name: 'Bonk', launchpad: 'unknown' });
  v.panels.market = { state: 'ok', via: 'ds+jup', reason: null, fetchedAt: NOW - 3000, stale: false };
  v.panels.rugcheck = { state: 'error', via: null, reason: 'HTTP 503', fetchedAt: null, stale: false };
  v.panels.holders = { state: 'needs-key', via: null, reason: 'needs key', fetchedAt: null, stale: false };
  const ages = tokenAges(v, NOW);
  assert.deepEqual(ages.find((a) => a.name === 'market'), { name: 'market', source: 'ds+jup', ageSec: 3, state: null });
  assert.equal(ages.find((a) => a.name === 'rugcheck')!.state, 'unavailable (HTTP 503)');
  assert.equal(ages.find((a) => a.name === 'holders')!.state, 'needs key');
  const state = makeFixtureState();
  state.larpByMint!.set(BONK, { verdict: 'UNVERIFIABLE', confidence: 0.4, at: NOW - 60_000 });
  const rep = tokenReport(state, v, NOW).join('\n');
  assert.match(rep, /coin {8}\$BONK · Bonk/, 'control characters stripped from token text');
  assert.match(rep, /LARP check  UNVERIFIABLE · confidence 0\.40 · model output, 1m old · a risk flag, not a certificate/);
});

test('one-shot `--export DIR` writes the PNG + report (fixtures → SAMPLE DATA)', async () => {
  const dir = tmp();
  try {
    let err = '';
    const stdout = new Writable({ write(_c, _e, cb) { cb(); } }) as unknown as NodeJS.WriteStream & { fd: 1 };
    const stderr = new Writable({ write(c, _e, cb) { err += c.toString(); cb(); } }) as unknown as NodeJS.WriteStream & { fd: 2 };
    Object.assign(stdout, { isTTY: false, columns: 120, rows: 40 }); Object.assign(stderr, { isTTY: false });
    const io = { stdout, stderr, stdin: { isTTY: false } as unknown as NodeJS.ReadStream & { fd: 0 }, env: { DEXTERM_HOME: dir, DEXTERM_OFFLINE: '1' } };
    assert.equal(await main(['--screen', 'watchlist', '--fixtures', '--width', '100', '--height', '30', '--no-images', '--export', dir], io), 0, err);
    const files = readdirSync(dir).filter((f) => f.startsWith('dexterm-watchlist-'));
    assert.equal(files.length, 2, err);
    const txt = readFileSync(join(dir, files.find((f) => f.endsWith('.txt'))!), 'utf8');
    assert.match(txt, /SAMPLE DATA/); assert.match(txt, /WATCHLIST/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
