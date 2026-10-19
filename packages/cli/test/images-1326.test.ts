// task-1326: coin images in the app — settings (file → env → flag; replay stays off unless asked), the
// --no-images flag, the screener / new-pairs / watchlist icon column and the token-header hero drawn from a
// fake ImageService (placeholder, block art, pixel slots), fixtures untouched, the doctor line, and the
// popup VM's same-origin image path. No network: the service is offline or fed from a temp cache dir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES, COIN_ICON_W, type Canvas } from '@dexterm/tui';
import { ImageService, encodePng, imageCacheKey, runDecodeJob } from '@dexterm/data';
import { createReplayFeed, makeFeedState, makeFixtureState, renderFrame, parseArgs, HELP, runDoctor, screenerView, resolveImagesConfig, normalizeImagesConfig, DEFAULT_IMAGES_CONFIG, popupImagePath, type AppState } from '../src/index.ts';
import { emptyView, renderTokenLive } from '../src/live/index.ts';
import { chartVMFromView } from '../src/popup.ts';
import type { DoctorDeps } from '../src/doctor.ts';

globalThis.fetch = (async (input: unknown) => { throw new Error(`network access blocked in tests: ${String(input)}`); }) as typeof fetch;

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(here, '..', '..', 'data', 'fixtures', 'live-sample.json');
const decode = async (bytes: Uint8Array, thumbMax: number) => runDecodeJob({ id: 1, bytes, thumbMax });

/** A 4×4 solid-colour PNG the service can serve from its cache dir. */
function solidPng(r: number, g: number, b: number): Uint8Array {
  const rgba = new Uint8Array(64); for (let i = 0; i < 16; i++) { rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255; }
  return new Uint8Array(encodePng({ w: 4, h: 4, rgba }));
}
function cellAt(c: Canvas, x: number, y: number) { const i = c.idx(x, y); return { ch: c.ch[i], fg: c.fg[i], bg: c.bg[i], hard: c.hard[i] }; }
function rowText(c: Canvas, y: number): string { return c.rowPlain(y); }
/**
 * The icon column's x, read off the table header (row 4) rather than assumed: the table has a 1-cell gap between
 * columns and draws the selection marker in the cell left of the rank column, so the row reads
 * `│   1 Z  ZEC` — rank right-aligned under `#`, one gap, the 2-cell icon, one gap, the symbol under `TOKEN`.
 */
function iconXFrom(c: Canvas): number {
  const head = rowText(c, 4);
  const tokenX = head.indexOf('TOKEN');
  assert.ok(tokenX > 0, `no TOKEN header: ${JSON.stringify(head.slice(0, 20))}`);
  return tokenX - 1 - COIN_ICON_W;
}

// ---------------------------------------------------------------------------------------------- settings + flag
test('settings: file → env → flag; replay/offline runs stay off unless the file or env says so', () => {
  const file = normalizeImagesConfig({ enabled: true, blocks: 'quad', protocol: 'iterm', thumbMax: 500, diskMb: 1, replay: false });
  assert.deepEqual({ ...file }, { enabled: true, blocks: 'quad', protocol: 'iterm', thumbMax: 192, diskMb: 4, replay: false, source: 'file' });
  assert.deepEqual(normalizeImagesConfig({ protocol: 'bogus', blocks: 'nope' }).protocol, 'auto');
  assert.deepEqual(normalizeImagesConfig(null), { ...DEFAULT_IMAGES_CONFIG, source: 'file' });
  assert.equal(resolveImagesConfig({}, false, { file }).enabled, true);
  assert.equal(resolveImagesConfig({ DEXTERM_IMAGES: '0' }, false, { file }).enabled, false);
  assert.equal(resolveImagesConfig({ DEXTERM_IMAGES: 'off' }, false, { file }).enabled, false);
  assert.equal(resolveImagesConfig({}, true, { file }).enabled, false, '--no-images wins over everything');
  assert.equal(resolveImagesConfig({ DEXTERM_IMAGES: 'on' }, true, { file }).enabled, false);
  const forced = resolveImagesConfig({ DEXTERM_IMAGES: 'sixel' }, false, { file });
  assert.equal(forced.protocol, 'sixel'); assert.equal(forced.enabled, true);
  assert.equal(resolveImagesConfig({}, false, { file, offline: true }).enabled, false, 'replay: a recording renders as recorded');
  assert.equal(resolveImagesConfig({ DEXTERM_IMAGES: '1' }, false, { file, offline: true }).enabled, true, '…unless asked');
  assert.equal(resolveImagesConfig({}, false, { file: { ...file, replay: true }, offline: true }).enabled, true);
  const off = normalizeImagesConfig({ enabled: false });
  assert.equal(resolveImagesConfig({}, false, { file: off }).enabled, false);
  assert.equal(resolveImagesConfig({ DEXTERM_IMAGES: 'on' }, false, { file: off }).enabled, true, 'env can re-enable a file that says off');
});

test('--no-images parses and is documented in --help', () => {
  assert.equal(parseArgs(['--no-images']).noImages, true);
  assert.equal(parseArgs([]).noImages, false);
  assert.match(HELP, /--no-images/);
});

// ---------------------------------------------------------------------------------------------- screens
// Loaded in a hook, not a top-level await: under --test-force-exit the runner exits once the tests registered so
// far have finished, so anything registered after a top-level await silently never runs (and still reports pass).
let replayFeed: ReturnType<typeof createReplayFeed>;
before(async () => { replayFeed = createReplayFeed(SAMPLE); await replayFeed.refresh(); });
after(() => replayFeed.close());

function stateWith(svc: ImageService | null, protocol: 'blocks' | 'kitty' = 'blocks'): AppState {
  const s = makeFeedState(replayFeed, 'replay', { selected: 1, theme: THEMES.cyberspace, calm: true });
  if (svc) { s.images = svc; s.imageProtocol = protocol; s.imageBlocks = 'half'; }
  return s;
}

test('screener: with images on, a 2-cell icon column sits after # and before TOKEN; off, the frame is byte-identical to before', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-img-cli-'));
  try {
    const svc = new ImageService({ dir, offline: true, decode });
    const plain = renderFrame(stateWith(null), 176, 48).toPlain();
    const st = stateWith(svc);
    const on = renderFrame(st, 176, 48);
    const rows = screenerView(st.screener);
    assert.ok(rows.length > 3);
    const head = rowText(on, 4);
    assert.match(head, /#\s+TOKEN/);
    // row 1 of the table (y = 6): rank, one gap, the 2-cell icon (the ticker initial on its hashed disc), one gap, the symbol
    const first = rows[0];
    const y = 6;
    const line = rowText(on, y);
    const initial = /[A-Za-z0-9]/.exec(first.symbol)?.[0].toUpperCase() ?? '?';
    const iconX = iconXFrom(on);
    assert.equal(iconX, head.indexOf('#') + 2, `icon column starts one gap after the right-aligned rank column: ${JSON.stringify(head.slice(0, 20))}`);
    const iconCell = cellAt(on, iconX, y);
    assert.equal(iconCell.ch, initial, `icon initial for ${first.symbol}: ${JSON.stringify(line.slice(0, 20))}`);
    assert.equal(iconCell.hard, 1, 'icon cells are hard (effects never touch them)');
    assert.equal(cellAt(on, iconX + 1, y).hard, 1, 'both icon cells are hard');
    assert.notEqual(iconCell.bg, on.theme.panel, 'placeholder disc has its own colour');
    assert.equal(line.indexOf(first.symbol), head.indexOf('TOKEN'), 'symbol sits under the TOKEN header, one gap after the icon');
    // images off: the icon column is gone and the symbol moves up to where the icon was
    const offHead = rowText(renderFrame(stateWith(null), 176, 48), 4);
    assert.equal(offHead.indexOf('TOKEN'), offHead.indexOf('#') + 2, 'no icon column with images off');
    assert.notEqual(on.toPlain(), plain);
    // fixtures never get the column (goldens untouched)
    const fx = makeFixtureState({ calm: true });
    fx.images = svc; fx.imageProtocol = 'blocks';
    const fxPlain = renderFrame(fx, 176, 48).toPlain();
    fx.images = null;
    assert.equal(fxPlain, renderFrame(fx, 176, 48).toPlain(), 'fixture rows carry no image and no column change');
    // compact frames skip the column silently
    const compact = renderFrame(stateWith(svc), 90, 40);
    const compactHead = rowText(compact, 4);
    assert.ok(!/TOKEN/.test(compactHead) || compactHead.indexOf('TOKEN') === compactHead.indexOf('#') + 2, 'no icon column at compact width');
    await svc.whenIdle(500);
    svc.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('screener: a cached image renders as quadrant block art in the icon cells (cells mode) or a recorded pixel slot (pixels mode)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-img-cli-'));
  try {
    const st0 = stateWith(null);
    const rows = screenerView(st0.screener);
    const url = 'https://cdn.example/coin.png';
    rows[0].image = url; // the sample recording predates DexScreener image fields in our fixtures; pin one
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${imageCacheKey(url)}.png`), solidPng(255, 0, 0));
    const svc = new ImageService({ dir, offline: true, decode });
    svc.get(url); await svc.whenIdle(1000);
    assert.equal(svc.get(url).state, 'ready');
    // stateWith() builds a new state over the SAME feed rows, so the pinned URL is visible to every render
    const cs = stateWith(svc);
    assert.equal(screenerView(cs.screener)[0].image, url);
    const c = renderFrame(cs, 176, 48);
    const iconX = iconXFrom(c);
    for (const x of [iconX, iconX + 1]) { const ic = cellAt(c, x, 6); assert.equal(ic.ch, '█', `quadrant cell at x=${x}`); assert.equal(ic.fg, '#ff0000'); assert.equal(ic.hard, 1); }
    assert.equal(c.images.length, 0);
    const px = stateWith(svc, 'kitty');
    screenerView(px.screener)[0].image = url;
    const p = renderFrame(px, 176, 48);
    assert.equal(p.imageMode, 'pixels');
    const slot = p.images.find((s) => s.y === 6);
    assert.ok(slot, 'a pixel slot was recorded for the icon'); assert.equal(slot!.x, iconX); assert.equal(slot!.w, 2); assert.equal(slot!.key, imageCacheKey(url));
    assert.equal(cellAt(p, iconX, 6).ch, ' ', 'blank hard cells under a pixel slot'); assert.equal(cellAt(p, iconX, 6).hard, 1);
    svc.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('token screen: the 8×4 hero sits at the left of a 4-row header and the title/price/CA shift right; off, the 3-row header is unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-img-cli-'));
  try {
    const url = 'https://cdn.example/wif.png';
    writeFileSync(join(dir, `${imageCacheKey(url)}.png`), solidPng(0, 0, 255));
    const svc = new ImageService({ dir, offline: true, decode });
    svc.get(url); await svc.whenIdle(1000);
    const view = emptyView({ mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF', name: 'dogwifhat', launchpad: 'pump.fun', image: url });
    const on = stateWith(svc); on.screen = 'token';
    const c = new (await import('@dexterm/tui')).Canvas(160, 45, THEMES.cyberspace);
    c.fill(0, 0, 160, 45, ' ', { bg: THEMES.cyberspace.bg });
    renderTokenLive(c, on, view);
    // hero: rows 2..5, cols 1..8, half-block art of a solid blue image → ▀ blue on blue
    for (const [x, y] of [[1, 2], [8, 2], [1, 5], [8, 5]] as const) { const cell = cellAt(c, x, y); assert.equal(cell.ch, '▀', `hero cell ${x},${y}`); assert.equal(cell.fg, '#0000ff'); assert.equal(cell.bg, '#0000ff'); assert.equal(cell.hard, 1); }
    assert.ok(rowText(c, 2).startsWith(' ▀▀▀▀▀▀▀▀ ‹ $WIF'), JSON.stringify(rowText(c, 2).slice(0, 24)));
    assert.ok(rowText(c, 4).includes('CA EKpQ'), 'CA row shifted after the hero');
    assert.ok(rowText(c, 6).includes('WIF/USD'), 'the chart box starts after the 4-row header');
    const off = stateWith(null); off.screen = 'token';
    const c2 = new (await import('@dexterm/tui')).Canvas(160, 45, THEMES.cyberspace);
    c2.fill(0, 0, 160, 45, ' ', { bg: THEMES.cyberspace.bg });
    renderTokenLive(c2, off, view);
    assert.ok(rowText(c2, 2).startsWith(' ‹ $WIF'));
    assert.ok(rowText(c2, 5).includes('WIF/USD'), 'three-row header when images are off');
    // the popup gets the same-origin path only once the thumbnail is cached, and the VM carries it
    assert.equal(popupImagePath(on, url), `/img/${imageCacheKey(url)}.png`);
    assert.equal(popupImagePath(on, 'https://cdn.example/other.png'), null);
    assert.equal(popupImagePath(off, url), null);
    const vm = chartVMFromView(view, { interval: '1h', series: null, image: `/img/${imageCacheKey(url)}.png` });
    assert.equal(vm.image, `/img/${imageCacheKey(url)}.png`);
    assert.equal(chartVMFromView(view).image, undefined, 'the v1 VM shape is untouched');
    svc.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('doctor: a Coin images line — pass with the protocol for a known terminal, warn with a fix for Apple Terminal.app', async () => {
  const base: DoctorDeps = { env: { COLORTERM: 'truecolor', TERM: 'xterm-256color' } as NodeJS.ProcessEnv, isTTY: true, nodeVersion: '24.0.0', platform: 'darwin', claude: async () => 'ok', probe: async () => ({ ok: true, reachable: true, status: 200, ms: 1 } as never), checkWritable: () => null, offline: true };
  const find = (r: Awaited<ReturnType<typeof runDoctor>>) => r.checks.find((c) => c.name === 'Coin images');
  const ghostty = find(await runDoctor({ ...base, env: { TERM_PROGRAM: 'ghostty', COLORTERM: 'truecolor' } as NodeJS.ProcessEnv }));
  assert.equal(ghostty?.status, 'pass'); assert.match(ghostty?.detail ?? '', /kitty graphics/);
  const apple = find(await runDoctor({ ...base, env: { TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' } as NodeJS.ProcessEnv }));
  assert.equal(apple?.status, 'warn'); assert.match(apple?.fix ?? '', /Ghostty|iTerm2/);
  const unknown = find(await runDoctor(base));
  assert.equal(unknown?.status, 'pass'); assert.match(unknown?.detail ?? '', /half-block/);
});
