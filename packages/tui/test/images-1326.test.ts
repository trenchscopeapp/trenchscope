// task-1326: coin images in the terminal — protocol detection from the environment and from recorded
// terminal replies, the three wire formats (kitty / iTerm2 / sixel) byte for byte, half-block and quadrant
// art with 256-colour dithering, the ticker placeholder, the coinImage() dispatch on a canvas, the flusher's
// changed-row report and the ImageLayer's lifecycle (place / keep / delete / re-emit / teardown).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Canvas, THEMES, Flusher, hexToAnsi256,
  protocolFromEnv, parseQueryReply, resolveProtocol, queryTerminal, CAPABILITY_QUERY,
  kittyTransmit, kittyPlace, kittyDeletePlacement, kittyDeleteAllPlacements, kittyFreeAll, itermInline, sixelEncode, cup, KITTY_CHUNK,
  drawBlockArt, drawPlaceholder, placeholderColor, placeholderInitial, nearest256, ditherTo256, sampleGrid,
  coinImage, ImageLayer, type Pixels, type QueryFacts,
} from '../src/index.ts';

// queryTerminal's timeout timer is unref'd (it must never block quit). Node 22's test runner cancels an await that
// only an unref'd timer can settle, so keep the event loop alive while this file runs.
const keepAlive = setInterval(() => {}, 60_000);
after(() => clearInterval(keepAlive));

const T = THEMES.cyberspace;
const ESC = '\x1b';

/** A w×h test image: left half red, right half blue, optional alpha. */
function halves(w: number, h: number, alpha = 255): Pixels {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; if (x < w / 2) { rgba[o] = 255; } else { rgba[o + 2] = 255; } rgba[o + 3] = alpha; }
  return { w, h, rgba };
}

// ---------------------------------------------------------------------------------------------- detection
test('protocolFromEnv: kitty / Ghostty / WezTerm / Konsole → kitty, iTerm2 → iterm, Terminal.app / tmux / unknown → blocks', () => {
  assert.equal(protocolFromEnv({ TERM: 'xterm-kitty' }).protocol, 'kitty');
  assert.equal(protocolFromEnv({ TERM_PROGRAM: 'ghostty' }).protocol, 'kitty');
  assert.equal(protocolFromEnv({ TERM_PROGRAM: 'WezTerm' }).protocol, 'kitty');
  assert.equal(protocolFromEnv({ KONSOLE_VERSION: '230800' }).protocol, 'kitty');
  assert.equal(protocolFromEnv({ TERM_PROGRAM: 'iTerm.app' }).protocol, 'iterm');
  assert.equal(protocolFromEnv({ LC_TERMINAL: 'iTerm2' }).protocol, 'iterm', 'LC_TERMINAL names iTerm2 (ssh / nested shells)');
  assert.equal(protocolFromEnv({ TERM_PROGRAM: 'tmux', LC_TERMINAL: 'iTerm2' }).protocol, 'blocks', 'tmux wins: no graphics passthrough');
  assert.equal(protocolFromEnv({ TMUX: '/tmp/tmux-1/default,1,0', TERM_PROGRAM: 'iTerm.app' }).protocol, 'blocks');
  const apple = protocolFromEnv({ TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' });
  assert.equal(apple.protocol, 'blocks'); assert.match(apple.reason, /Apple Terminal/);
  assert.equal(protocolFromEnv({}).protocol, 'blocks');
});

test('parseQueryReply: recorded replies — kitty OK + cell size + DA1 with sixel; a DA1 without 4; partial input; keys after the reply', () => {
  // WezTerm-style: kitty ack, cell size 18×9, DA1 advertising sixel (4)
  const wez = `${ESC}_Gi=31;OK${ESC}\\${ESC}[6;18;9t${ESC}[?62;4;22c`;
  const r1 = parseQueryReply(wez);
  assert.equal(r1.done, true);
  assert.deepEqual({ ...r1.facts }, { kittyOk: true, sixel: true, da1: '?62;4;22', cellPx: { w: 9, h: 18 }, consumed: wez.length });
  // xterm-like: no kitty, no cell size, DA1 without sixel, then a keypress 'j' and an arrow
  const x = `${ESC}[?1;2cj${ESC}[B`;
  const r2 = parseQueryReply(x);
  assert.equal(r2.done, true); assert.equal(r2.facts.kittyOk, false); assert.equal(r2.facts.sixel, false); assert.equal(r2.facts.consumed, `${ESC}[?1;2c`.length);
  assert.equal(x.slice(r2.facts.consumed), `j${ESC}[B`, 'the keys are handed back');
  // partial: the DA1 has not arrived yet
  const part = `${ESC}_Gi=31;OK${ESC}\\${ESC}[?62;`;
  const r3 = parseQueryReply(part);
  assert.equal(r3.done, false); assert.equal(r3.facts.kittyOk, true);
  // Apple Terminal.app answers DA1 only: CSI ? 1 ; 2 c
  const apple = parseQueryReply(`${ESC}[?1;2c`);
  assert.equal(apple.done, true); assert.equal(apple.facts.sixel, false); assert.equal(apple.facts.cellPx, null);
});

test('resolveProtocol: the query refines the environment; DEXTERM_IMAGES pins; tmux never gets pixels', () => {
  const q = (over: Partial<QueryFacts>): QueryFacts => ({ kittyOk: false, sixel: false, da1: '?1;2', cellPx: null, consumed: 0, elapsedMs: 5, timedOut: false, ...over });
  assert.equal(resolveProtocol({ TERM_PROGRAM: 'Apple_Terminal' }, q({})).protocol, 'blocks');
  assert.equal(resolveProtocol({ TERM: 'xterm' }, q({ kittyOk: true })).protocol, 'kitty', 'an unknown terminal that answers the kitty query gets kitty');
  assert.equal(resolveProtocol({ TERM: 'xterm' }, q({ sixel: true })).protocol, 'sixel');
  assert.equal(resolveProtocol({ TERM_PROGRAM: 'iTerm.app' }, q({})).protocol, 'iterm', 'iTerm2 does not answer the kitty query; env wins');
  assert.equal(resolveProtocol({ TERM_PROGRAM: 'ghostty' }, q({ timedOut: true })).protocol, 'kitty', 'no answer within the timeout: trust the environment');
  assert.equal(resolveProtocol({ TERM_PROGRAM: 'ghostty' }, q({ kittyOk: false, sixel: false })).protocol, 'blocks', 'the terminal explicitly refused the kitty query');
  assert.equal(resolveProtocol({ TERM_PROGRAM: 'Apple_Terminal', DEXTERM_IMAGES: 'sixel' }, q({})).protocol, 'sixel');
  assert.equal(resolveProtocol({ TMUX: '1', TERM: 'xterm-kitty' }, q({ kittyOk: true })).protocol, 'blocks');
  assert.equal(resolveProtocol({ TERM_PROGRAM: 'iTerm.app' }, null).protocol, 'iterm');
});

test('queryTerminal: writes the probe, parses the reply off the input, returns leftover keys; times out quietly', async () => {
  let written = '';
  let handler: ((s: string) => void) | null = null;
  const io = { write: (s: string) => { written += s; }, onData: (cb: (s: string) => void) => { handler = cb; return () => { handler = null; }; } };
  const p = queryTerminal(io, 500);
  assert.equal(written, CAPABILITY_QUERY);
  (handler as unknown as (s: string) => void)(`${ESC}_Gi=31;OK${ESC}\\`);
  (handler as unknown as (s: string) => void)(`${ESC}[6;20;10t${ESC}[?62;4ck`);
  const r = await p;
  assert.equal(r.facts.kittyOk, true); assert.deepEqual(r.facts.cellPx, { w: 10, h: 20 }); assert.equal(r.facts.timedOut, false); assert.equal(r.leftover, 'k');
  assert.equal(handler, null, 'unsubscribed');
  const t = await queryTerminal({ write: () => {}, onData: () => () => {} }, 20);
  assert.equal(t.facts.timedOut, true); assert.equal(t.facts.kittyOk, false);
});

// ---------------------------------------------------------------------------------------------- wire formats
test('kitty: transmit chunks at 4096, places by id/pid with C=1 and q=2, deletes by placement and all', () => {
  const img = halves(2, 1);
  const t = kittyTransmit(7, img);
  assert.equal(t, `${ESC}_Ga=t,f=32,s=2,v=1,i=7,q=2,m=0;${Buffer.from(img.rgba).toString('base64')}${ESC}\\`);
  const big = kittyTransmit(8, { w: 64, h: 64, rgba: new Uint8Array(64 * 64 * 4) });
  const chunks = big.split(`${ESC}\\`).filter(Boolean);
  assert.ok(chunks.length > 1);
  assert.ok(chunks[0].startsWith(`${ESC}_Ga=t,f=32,s=64,v=64,i=8,q=2,m=1;`)); assert.ok(chunks[1].startsWith(`${ESC}_Gm=`));
  assert.ok(chunks[chunks.length - 1].startsWith(`${ESC}_Gm=0;`));
  for (const c of chunks) assert.ok(c.split(';')[1].length <= KITTY_CHUNK);
  assert.equal(kittyPlace(7, 3, 2, 1), `${ESC}_Ga=p,i=7,p=3,c=2,r=1,C=1,q=2${ESC}\\`);
  assert.equal(kittyDeletePlacement(7, 3), `${ESC}_Ga=d,d=i,i=7,p=3,q=2${ESC}\\`);
  assert.equal(kittyDeleteAllPlacements(), `${ESC}_Ga=d,d=a,q=2${ESC}\\`);
  assert.equal(kittyFreeAll(), `${ESC}_Ga=d,d=A,q=2${ESC}\\`);
  assert.equal(cup(3, 10), `${ESC}[4;11H`);
});

test('iterm: OSC 1337 inline file with cell width/height, aspect preserved, cursor unmoved, BEL terminated', () => {
  const png = new Uint8Array([1, 2, 3]);
  assert.equal(itermInline(png, 2, 1), `${ESC}]1337;File=inline=1;size=3;width=2;height=1;preserveAspectRatio=1;doNotMoveCursor=1:AQID\x07`);
});

test('sixel: a 2×6 red|blue image encodes to a palette of two colours and one band with full columns', () => {
  const s = sixelEncode(halves(2, 6));
  assert.ok(s.startsWith(`${ESC}P0;1q"1;1;2;6`));
  assert.ok(s.endsWith(`-${ESC}\\`));
  // red: r=5 g=0 b=0 → index (5*7+0)*6+0 = 210 at 100%,0%,0%; blue: index 5 → 0,0,100
  assert.ok(s.includes('#210;2;100;0;0')); assert.ok(s.includes('#5;2;0;0;100'));
  // a full 6-row column is bits 63 → char '~'; red is column 0 then an empty column; blue is empty then full
  assert.ok(s.includes('#210~?') || s.includes('#210~'), s);
  assert.ok(s.includes('#5?~'), s);
  assert.equal(sixelEncode({ w: 0, h: 0, rgba: new Uint8Array(0) }), '');
});

// ---------------------------------------------------------------------------------------------- block art + placeholder
test('half-block art: ▀ with fg = top sample, bg = bottom sample; cells are hard and out of the rain', () => {
  const c = new Canvas(10, 4, T);
  c.rainZone(0, 0, 10, 4, 1);
  // 2×4 px image: top half red, bottom half blue → a 2×2 cell box shows red over red (row 0) and blue over blue (row 1)
  const rgba = new Uint8Array(2 * 4 * 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) { const o = (y * 2 + x) * 4; if (y < 2) rgba[o] = 255; else rgba[o + 2] = 255; rgba[o + 3] = 255; }
  drawBlockArt(c, 1, 1, 2, 2, { w: 2, h: 4, rgba }, { depth: 'truecolor', bg: T.panel, mode: 'half' });
  const i = c.idx(1, 1), j = c.idx(2, 2);
  assert.equal(c.ch[i], '▀'); assert.equal(c.fg[i], '#ff0000'); assert.equal(c.bg[i], '#ff0000');
  assert.equal(c.ch[j], '▀'); assert.equal(c.fg[j], '#0000ff'); assert.equal(c.bg[j], '#0000ff');
  assert.equal(c.hard[i], 1); assert.equal(c.zone[i], 0, 'no rain over an icon');
  assert.equal(c.ch[c.idx(0, 0)], ' ', 'nothing outside the box');
});

test('quadrant art: a 2-cell row icon gets 4×2 samples; a red|blue split becomes two full-colour cells, a mixed cell a quadrant glyph', () => {
  const c = new Canvas(6, 1, T);
  drawBlockArt(c, 0, 0, 2, 1, halves(8, 4), { depth: 'truecolor', bg: T.panel, mode: 'quad' });
  assert.equal(c.ch[c.idx(0, 0)], '█'); assert.equal(c.fg[c.idx(0, 0)], '#ff0000');
  assert.equal(c.ch[c.idx(1, 0)], '█'); assert.equal(c.fg[c.idx(1, 0)], '#0000ff');
  // a 1-cell box over the same image: left two samples red, right two blue → ▌ with fg red (brighter luma? blue is darker) or ▐
  const c2 = new Canvas(1, 1, T);
  drawBlockArt(c2, 0, 0, 1, 1, halves(8, 4), { depth: 'truecolor', bg: T.panel, mode: 'quad' });
  const g = c2.ch[0];
  assert.ok(g === '▌' || g === '▐', `got ${g}`);
  const fg = c2.fg[0], bg = c2.bg[0];
  assert.ok((fg === '#ff0000' && bg === '#0000ff') || (fg === '#0000ff' && bg === '#ff0000'));
});

test('256 colours: every emitted colour is an exact xterm-cube/grey entry; dithering keeps a gradient from collapsing', () => {
  // a 16-wide horizontal grey ramp sampled at 8 cells: without dithering every cell snaps to 1–2 grey levels
  const w = 32, h = 2, rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; const v = 60 + Math.round((x / (w - 1)) * 40); rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255; }
  const img = { w, h, rgba };
  const c = new Canvas(16, 1, T);
  drawBlockArt(c, 0, 0, 16, 1, img, { depth: '256', bg: T.panel, mode: 'half' });
  const seen = new Set<string>();
  for (let x = 0; x < 16; x++) {
    const fg = c.fg[x], bg = c.bg[x];
    for (const col of [fg, bg]) {
      const idx = hexToAnsi256(col);
      // exact: mapping back the index gives the same hex (cube steps 0/95/135/175/215/255, greys 8+10i)
      const v = idx >= 232 ? 8 + 10 * (idx - 232) : null;
      if (v !== null) assert.equal(col, '#' + [v, v, v].map((n) => n.toString(16).padStart(2, '0')).join(''));
      seen.add(col);
    }
  }
  assert.ok(seen.size >= 3, `dithered ramp uses ${seen.size} palette entries`);
  assert.deepEqual(nearest256(100, 100, 100), [98, 98, 98]);
  // 102.5 snaps down to 98 (error +4.5); 7/16 of that pushes the neighbour over the midpoint to 108
  const flat = new Float32Array([102.5, 102.5, 102.5, 102.5, 102.5, 102.5]);
  ditherTo256(flat, 2, 1);
  assert.deepEqual([flat[0], flat[3]], [98, 108], 'the second pixel absorbed the first one\'s error');
});

test('placeholder: hashed stable colour, ticker initial, legible ink, never an error glyph', () => {
  assert.equal(placeholderColor('WIF'), placeholderColor('wif'));
  assert.notEqual(placeholderColor('WIF'), placeholderColor('BONK'));
  assert.equal(placeholderInitial('$wif'), 'W'); assert.equal(placeholderInitial('░░░'), '?'); assert.equal(placeholderInitial('1INCH'), '1');
  const c = new Canvas(10, 4, T);
  drawPlaceholder(c, 1, 0, 8, 4, 'WIF', { depth: 'truecolor', bg: T.bg });
  const centre = c.idx(1 + 3, 1);
  assert.equal(c.ch[centre], 'W'); assert.equal(c.bg[centre], placeholderColor('WIF'));
  assert.ok(c.fg[centre] === '#000000' || c.fg[centre] === '#ffffff');
  assert.equal(c.ch[c.idx(1, 0)], '▗', 'rounded corner');
  const c256 = new Canvas(2, 1, T);
  drawPlaceholder(c256, 0, 0, 2, 1, 'BONK', { depth: '256', bg: T.panel });
  assert.equal(c256.ch[0], 'B');
  const idx = hexToAnsi256(c256.bg[0]);
  assert.ok(idx >= 16 && idx <= 255);
});

test('coinImage: pixels mode records a slot over blank hard cells; cells mode draws art; no image draws the placeholder', () => {
  const img = halves(8, 8);
  const c = new Canvas(10, 2, T);
  c.imageMode = 'pixels';
  coinImage(c, { x: 0, y: 0, w: 2, h: 1, symbol: 'WIF', img, key: 'k1', depth: 'truecolor', bg: T.panel });
  assert.equal(c.images.length, 1); assert.deepEqual({ x: c.images[0].x, w: c.images[0].w, key: c.images[0].key }, { x: 0, w: 2, key: 'k1' });
  assert.equal(c.ch[0], ' '); assert.equal(c.hard[0], 1);
  coinImage(c, { x: 4, y: 0, w: 2, h: 1, symbol: 'WIF', img: null, pending: true, key: null, depth: 'truecolor', bg: T.panel });
  assert.equal(c.images.length, 1, 'a placeholder records no slot'); assert.equal(c.ch[c.idx(4, 0)], 'W');
  const cells = new Canvas(10, 2, T);
  coinImage(cells, { x: 0, y: 0, w: 2, h: 1, symbol: 'WIF', img, key: 'k1', depth: 'truecolor', bg: T.panel, mode: 'quad' });
  assert.equal(cells.images.length, 0); assert.equal(cells.ch[0], '█');
  const copy = new Canvas(10, 2, T); copy.copyFrom(c);
  assert.equal(copy.images.length, 1); assert.equal(copy.imageMode, 'pixels');
});

// ---------------------------------------------------------------------------------------------- flusher + layer
test('flusher reports the rows it rewrote', () => {
  const f = new Flusher({ depth: 'none' });
  const a = new Canvas(4, 3, T);
  const r1 = f.diff(a);
  assert.equal(r1.full, true); assert.deepEqual(r1.changed, [true, true, true]);
  const b = new Canvas(4, 3, T); b.text(0, 1, 'hi');
  const r2 = f.diff(b);
  assert.equal(r2.full, false); assert.deepEqual(r2.changed, [false, true, false]); assert.equal(r2.rows, 1);
});

test('ImageLayer kitty: transmit once per key, place new slots, keep unchanged ones, delete moved/gone ones, clear on screen change, free on teardown', () => {
  const layer = new ImageLayer('kitty', { bg: () => T.bg, cellPx: { w: 9, h: 18 } });
  const img = halves(4, 4);
  const slotA = { key: 'A', x: 2, y: 3, w: 2, h: 1, img };
  const out1 = layer.sync({ slots: [slotA], changed: 'all', screen: 'screener' });
  assert.ok(out1.includes(`${ESC}_Ga=t,f=32,s=4,v=4,i=1000,q=2,m=0;`)); assert.ok(out1.includes(`${ESC}[4;3H${ESC}_Ga=p,i=1000,p=1,c=2,r=1,C=1,q=2${ESC}\\`));
  // same slot, rows changed: nothing to do for kitty (placements survive text redraws)
  assert.equal(layer.sync({ slots: [slotA], changed: [false, false, false, true], screen: 'screener' }), '');
  // the slot moved one row (scrolled): old placement deleted, new one placed, NO re-transmit
  const out3 = layer.sync({ slots: [{ ...slotA, y: 4 }], changed: [false, false, false, true, true], screen: 'screener' });
  assert.ok(out3.includes(kittyDeletePlacement(1000, 1))); assert.ok(out3.includes(`${ESC}[5;3H${ESC}_Ga=p,i=1000,p=2,`)); assert.ok(!out3.includes('a=t,'));
  // screen change: every placement deleted first, then the new screen's slots placed
  const out4 = layer.sync({ slots: [{ key: 'B', x: 1, y: 2, w: 8, h: 4, img }], changed: 'all', screen: 'token' });
  assert.ok(out4.startsWith(kittyDeleteAllPlacements())); assert.ok(out4.includes('i=1001,q=2')); assert.ok(out4.includes('c=8,r=4'));
  assert.equal(layer.sync({ slots: [], changed: [false, false, false, false, false, false], screen: 'token' }), kittyDeletePlacement(1001, 3));
  assert.equal(layer.teardown(), kittyFreeAll());
  assert.equal(layer.teardown(), '', 'idempotent');
  assert.deepEqual({ t: layer.stats.transmits, p: layer.stats.places, d: layer.stats.deletes }, { t: 2, p: 3, d: 3 });
});

test('ImageLayer iterm/sixel: emit on first sight and whenever a slot row was rewritten; untouched rows emit nothing', () => {
  const enc = (p: Pixels) => new Uint8Array([p.w, p.h]);
  const layer = new ImageLayer('iterm', { bg: () => T.bg, encodePng: enc, cellPx: { w: 9, h: 18 } });
  const img = halves(4, 4);
  const slot = { key: 'A', x: 2, y: 3, w: 2, h: 1, img };
  const first = layer.sync({ slots: [slot], changed: [false, false, false, false], screen: 's' });
  assert.ok(first.startsWith(`${ESC}[4;3H${ESC}]1337;File=inline=1;`), 'a new slot is drawn even when its row text did not change');
  assert.equal(layer.sync({ slots: [slot], changed: [false, false, false, false], screen: 's' }), '');
  assert.ok(layer.sync({ slots: [slot], changed: [false, false, false, true], screen: 's' }).includes('1337'), 'row rewritten → re-emitted');
  assert.ok(layer.sync({ slots: [slot], changed: 'all', screen: 's' }).includes('1337'));
  assert.equal(layer.teardown(), '');
  const six = new ImageLayer('sixel', { bg: () => T.bg, cellPx: { w: 8, h: 16 } });
  const s = six.sync({ slots: [{ key: 'A', x: 0, y: 0, w: 8, h: 4, img }], changed: 'all', screen: 's' });
  assert.ok(s.startsWith(`${ESC}[1;1H${ESC}P0;1q"1;1;`)); assert.ok(s.endsWith(`${ESC}\\`));
  // sixel height is a multiple of 6 and the box is square-ish (8 cells × 8 px = 64 wide, 4 rows × 16 = 64 tall)
  assert.ok(/"1;1;64;60/.test(s) || /"1;1;64;64/.test(s) || /"1;1;64;66/.test(s), s.slice(0, 30));
});

test('sampleGrid composites alpha over the surface (a transparent logo never draws black)', () => {
  const g = sampleGrid(halves(2, 2, 0), 1, 1, '#102030');
  assert.deepEqual([Math.round(g[0]), Math.round(g[1]), Math.round(g[2])], [0x10, 0x20, 0x30]);
});
