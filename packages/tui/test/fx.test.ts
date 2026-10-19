import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Canvas, THEMES, hash3, makeVfx, setSources, pulse, stepVfx, rain, trails, aberrate, mosh, shake, scanlines, applyFx,
  blinkFrame, blinkFrames, decrypt, decryptText, spinnerGlyph, logoRows, bootLogo, marketActivity, candleActivity, blendActivity,
  contrast, luminance, mix, toast, isHardGlyph, KATAKANA, CODE, CODE_ASCII, type Vfx,
} from '../src/index.ts';
import type { Candle } from '@dexterm/data';

const T = THEMES.cyberspace;
const KANA = new RegExp(`[${KATAKANA}]`);

function scene(w = 60, h = 12): Canvas {
  const c = new Canvas(w, h, T);
  c.fill(0, 0, w, h, ' ', { bg: T.bg });
  c.rainZone(0, 0, w, h, 1);
  c.box(10, 2, 30, 6, { title: 'PANEL' });
  c.text(12, 4, '$1,234.5 ▲12.3%', { fg: T.text, bg: T.panel });
  c.text(2, 10, 'q quit', { fg: T.muted, bg: T.bg, hard: true });
  return c;
}

test('hash3 is a stable platform-independent hash', () => {
  assert.equal(hash3(1, 2, 3), hash3(1, 2, 3));
  assert.notEqual(hash3(1, 2, 3), hash3(1, 2, 4));
  assert.notEqual(hash3(0), hash3(1));
  for (const v of [hash3(7, 41, 9), hash3(-5, 0, 0)]) assert.ok(Number.isInteger(v) && v >= 0 && v < 2 ** 32);
});

test('the hard mask: put() marks data glyphs, soft/hard override it, putFx refuses hard, non-blank and out-of-zone cells', () => {
  const c = new Canvas(10, 2, T);
  c.text(0, 0, '12 ▲', {});
  assert.deepEqual(Array.from(c.hard.slice(0, 4)), [1, 1, 0, 1]);
  c.put(5, 0, '█', { soft: true });
  c.put(6, 0, '█', { hard: true });
  c.put(7, 0, 'A', { soft: true });
  assert.deepEqual(Array.from(c.hard.slice(5, 8)), [0, 1, 0]);
  assert.ok(isHardGlyph('7') && isHardGlyph('▼') && isHardGlyph('$') && !isHardGlyph('█') && !isHardGlyph('ｱ') && !isHardGlyph(' '));
  assert.equal(c.putFx(0, 0, 'ｱ'), false, 'hard cell refused');
  assert.equal(c.ch[0], '1');
  assert.equal(c.putFx(5, 0, 'ｱ'), false, 'non-blank soft cell refused without overwrite');
  assert.equal(c.putFx(5, 0, 'ｱ', { overwrite: true }), true);
  assert.equal(c.putFx(2, 0, 'ｱ', {}, true), false, 'blank but outside a zone when a zone is required');
  c.rainZone(2, 0, 1, 1, 2);
  assert.equal(c.putFx(2, 0, 'ｱ', { fg: '#ffffff', b: true }, true), true);
  assert.equal(c.ch[2], 'ｱ');
  assert.equal(c.at[2] & 1, 1);
  assert.equal(c.putFx(-1, 0, 'x'), false);
  c.noRain(2, 0, 1, 1);
  assert.equal(c.zone[2], 0);
});

test('box titles register headings; copyFrom duplicates every buffer', () => {
  const c = scene();
  assert.ok(c.headings.some((h) => h.y === 2 && h.x === 12 && h.w === 7));
  const d = new Canvas(c.w, c.h, T);
  d.copyFrom(c);
  assert.deepEqual(d.ch, c.ch);
  assert.deepEqual(Array.from(d.hard), Array.from(c.hard));
  assert.deepEqual(Array.from(d.zone), Array.from(c.zone));
  d.ch[0] = 'x';
  assert.notEqual(c.ch[0], 'x', 'copies, not aliases');
});

test('rain falls only on blank zone cells, never on hard cells; a frame index reproduces exactly; trails linger then fade', () => {
  const mk = (frame: number): [Canvas, Vfx] => {
    const v = makeVfx({ seed: 7, sources: ['GIGA', 'WIFHAT'] });
    v.frame = frame;
    v.activity = 1;
    const c = scene(80, 20);
    rain(c, v);
    return [c, v];
  };
  const [a] = mk(40);
  const [b] = mk(40);
  assert.deepEqual(a.ch, b.ch, 'same frame → same cells');
  assert.deepEqual(a.fg, b.fg);
  const [c2] = mk(41);
  assert.notDeepEqual(a.ch, c2.ch, 'the next frame moves the drops');
  const base = scene(80, 20);
  let rained = 0;
  for (let i = 0; i < a.ch.length; i++) {
    if (a.ch[i] === base.ch[i]) continue;
    rained += 1;
    assert.equal(base.ch[i], ' ', 'only blank cells');
    assert.equal(base.hard[i], 0, 'never a hard cell');
    assert.ok(base.zone[i] > 0, 'only inside a zone');
  }
  assert.ok(rained > 100, `rain density (${rained})`);
  // source strings appear read downwards
  let col = -1;
  for (let x = 0; x < a.w && col < 0; x++) {
    let s = '';
    for (let y = 0; y < a.h; y++) s += a.ch[a.idx(x, y)];
    if (/GIGA|WIFHAT/.test(s)) col = x;
  }
  assert.ok(col >= 0, 'a ticker reads down a column');
  // trails: after the drop moves on, the vacated cell lingers dimmer for three frames then clears
  const [c3, v3] = mk(40);
  const cells = new Set<number>();
  for (let i = 0; i < c3.ch.length; i++) if (c3.ch[i] !== base.ch[i]) cells.add(i);
  const next = scene(80, 20);
  v3.frame = 60;
  rain(next, v3);
  trails(next, v3);
  const lingering = [...cells].filter((i) => next.ch[i] !== ' ' && next.ch[i] === c3.ch[i] && next.fg[i] !== c3.fg[i]);
  assert.ok(lingering.length > 0, 'some previous cells linger with a dimmer colour');
  for (let k = 0; k < 4; k++) { const n2 = scene(80, 20); v3.frame += 1; trails(n2, v3); }
  assert.equal(v3.trail.size, 0, 'trails expire after 3 frames');
});

test('intensity: off disables every pass; normal rains sparser than fever; calm pulses are no-ops', () => {
  const off = makeVfx({ seed: 7, calm: true });
  const c = scene();
  const before = c.ch.slice();
  applyFx(c, off);
  assert.deepEqual(c.ch, before);
  pulse(off, 'rug');
  assert.equal(off.glitch, 0);
  assert.equal(off.mood, 'neutral');
  const count = (v: Vfx) => { v.frame = 40; v.activity = 0.6; const s = scene(120, 30); rain(s, v); return s.ch.filter((ch, i) => ch !== ' ' && !s.hard[i] && (KANA.test(ch) || /[0-9A-Z]/.test(ch))).length; };
  const fever = makeVfx({ seed: 7, intensity: 'fever' });
  const normal = makeVfx({ seed: 7, intensity: 'normal' });
  assert.ok(count(normal) < count(fever));
  assert.equal(fever.baseline, 0.12);
  assert.equal(normal.baseline, 0);
});

test('pulse + stepVfx: events set glitch / shake / stutter / mood and decay', () => {
  const v = makeVfx({ seed: 1, intensity: 'fever' });
  pulse(v, 'newpair');
  assert.equal(v.glitch, 0.8); assert.equal(v.shake, 2); assert.equal(v.stutter, 2);
  pulse(v, 'rug');
  assert.equal(v.glitch, 1); assert.equal(v.shake, 3); assert.equal(v.mood, 'dump');
  stepVfx(v);
  assert.equal(v.frame, 1); assert.ok(Math.abs(v.glitch - 0.82) < 1e-9); assert.equal(v.shake, 2); assert.equal(v.stutter, 2);
  for (let i = 0; i < 40; i++) stepVfx(v);
  assert.equal(v.glitch, 0); assert.equal(v.shake, 0); assert.equal(v.stutter, 0);
  pulse(v, 'pump');
  assert.equal(v.mood, 'pump'); assert.equal(v.activity, 1); assert.equal(v.shake, 1);
  pulse(v, 'dump');
  assert.equal(v.mood, 'dump');
});

test('aberrate only recolours heading glyphs (never changes them) and ghosts land in blank neighbours during an event', () => {
  const v = makeVfx({ seed: 3, intensity: 'fever' });
  v.frame = 41;
  const c = scene();
  const before = c.ch.slice();
  aberrate(c, v);
  assert.deepEqual(c.ch, before, 'idle: no glyph changes at all');
  pulse(v, 'rug');
  let ghosts = 0;
  for (let f = 0; f < 20 && ghosts === 0; f++) {
    const d = scene();
    v.frame = 100 + f;
    aberrate(d, v);
    for (let i = 0; i < d.ch.length; i++) if (d.ch[i] !== before[i]) { ghosts += 1; assert.equal(before[i], ' '); assert.equal(d.hard[i], 0); }
  }
  assert.ok(ghosts > 0, 'an event glitch echoes a heading glyph into a blank neighbour');
});

test('mosh and shake move soft cells only; hard cells keep their glyphs and colours (shake moves them with the frame)', () => {
  const v = makeVfx({ seed: 3, intensity: 'fever' });
  pulse(v, 'rug');
  v.frame = 41;
  const c = scene(80, 20);
  const before = scene(80, 20);
  mosh(c, v);
  for (let i = 0; i < c.ch.length; i++) if (before.hard[i]) { assert.equal(c.ch[i], before.ch[i]); assert.equal(c.fg[i], before.fg[i]); }
  const s = scene(80, 20);
  shake(s, v);
  // every hard glyph of the original is still present somewhere on its row (shifted by ≤ 2) with its colour
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
    const i = before.idx(x, y);
    if (!before.hard[i]) continue;
    const found = [-2, -1, 0, 1, 2].some((dx) => { const j = s.idx(x + dx, y) ; return x + dx >= 0 && x + dx < s.w && s.ch[j] === before.ch[i] && s.fg[j] === before.fg[i]; })
      || [-2, -1, 0, 1, 2].some((dx) => { const j = s.idx(x + dx, y + 1); return y + 1 < s.h && x + dx >= 0 && x + dx < s.w && s.ch[j] === before.ch[i]; });
    assert.ok(found, `hard glyph '${before.ch[i]}' at ${x},${y} survives the shake`);
  }
});

test('scanlines tint odd rows only, uniformly', () => {
  const c = scene();
  const before = c.bg.slice();
  scanlines(c);
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
    const i = c.idx(x, y);
    if (y % 2) assert.equal(c.bg[i], mix(before[i], T.scan, 0.07)); else assert.equal(c.bg[i], before[i]);
  }
});

test('applyFx is deterministic per frame and leaves calm untouched', () => {
  const mk = () => { const v = makeVfx({ seed: 9, sources: ['A1', 'B2'] }); v.frame = 77; pulse(v, 'newpair'); const c = scene(100, 30); applyFx(c, v); return c; };
  const a = mk(), b = mk();
  assert.deepEqual(a.ch, b.ch); assert.deepEqual(a.fg, b.fg); assert.deepEqual(a.bg, b.bg);
});

test('blink: eyelids, black beat, code flood, decrypt; blinkFrames ≤ 350 ms; the final frame equals the target', () => {
  const v = makeVfx({ seed: 7 });
  const from = scene(60, 12), to = scene(60, 12);
  to.text(12, 5, 'TARGET', { fg: T.text, bg: T.panel });
  const lids = blinkFrame(from, to, 0.14, v);
  assert.ok(lids.ch.includes('▀') && lids.ch.includes('▄'), 'lid edges');
  assert.equal(lids.bg[0], '#000000');
  const black = blinkFrame(from, to, 0.33, v);
  assert.ok(black.ch.every((ch) => ch === ' '));
  const flood = blinkFrame(from, to, 0.55, v);
  assert.ok(flood.ch.some((ch) => CODE.includes(ch) && ch !== ' '));
  const dec = blinkFrame(from, to, 0.8, v);
  assert.ok(dec.ch.some((ch, i) => ch !== to.ch[i]), 'still decrypting at 80 %');
  const done = blinkFrame(from, to, 1, v);
  assert.deepEqual(done.ch, to.ch);
  assert.deepEqual(done.fg, to.fg);
  assert.deepEqual(blinkFrame(null, to, 0.1, v).bg.slice(0, 60), new Array(60).fill('#000000'), 'no `from`: black');
  for (const fps of [5, 15, 30, 60]) { const n = blinkFrames(fps); assert.ok(n >= 4 && n <= 11); if (fps >= 12) assert.ok(n / fps <= 0.35); }
});

test('decrypt: plain up to revealed, a 6-glyph scramble window, blank after; the spinner cycles the Claude Code family', () => {
  const cells = decrypt('hello world foo', 5, 3);
  assert.equal(cells.slice(0, 5).map((c) => c.ch).join(''), 'hello');
  assert.equal(cells[5].kind, 'text', 'the space inside the window stays a space');
  assert.ok(cells.slice(6, 11).every((c) => c.kind === 'code' && CODE.includes(c.ch)));
  assert.ok(cells.slice(11).every((c) => c.kind === 'blank'));
  assert.deepEqual(decrypt('ab', 0, 1, 6, CODE_ASCII).map((c) => c.ch).every((ch) => !KANA.test(ch)), true);
  const c = new Canvas(20, 1, T);
  decryptText(c, 0, 0, 'hello world', 5, 3, { fg: T.ai, bg: T.panel });
  assert.equal(c.toPlain().slice(0, 5), 'hello');
  assert.equal(c.hard[6], 0, 'scramble glyphs are soft');
  assert.equal(c.fg[6], T.rain[2]);
  const seen = new Set<string>();
  for (let f = 0; f < 18; f++) seen.add(spinnerGlyph(f));
  assert.deepEqual([...seen].sort(), ['·', '✢', '✳', '✶', '✻', '✽'].sort());
});

test('bootLogo: 5-row block font, jitter bounded, returns its rect; the toast clears its own rain zone', () => {
  const rows = logoRows('DEXTERM');
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.length <= 41));
  const c = new Canvas(80, 12, T);
  c.rainZone(0, 0, 80, 12, 1);
  const r = bootLogo(c, 40, 2, { frame: 3 }, 0.9);
  assert.equal(r.h, 5);
  assert.ok(c.ch.includes('█'));
  assert.ok(c.ch.some((ch) => ch === '▌' || ch === '▐'), 'fringes at high intensity');
  const tc = new Canvas(80, 12, T);
  tc.rainZone(0, 0, 80, 12, 1);
  toast(tc, { text: 'hello', level: 'up', until: 10 });
  assert.match(tc.toPlain(), /hello/);
  assert.equal(tc.zone[tc.idx(tc.w - 4, tc.h - 3)], 0, 'toast cells are not rain zones');
});

test('market → rain: deltas map to activity 0.15..1 and ±3 % bias to mood; candles drive the token screen; EMA blends', () => {
  const quiet = marketActivity([0.5, -0.4, 0.2]);
  assert.ok(quiet.activity >= 0.15 && quiet.activity < 0.2);
  assert.equal(quiet.mood, 'neutral');
  const hot = marketActivity([9, 8, 7, 6]);
  assert.equal(hot.activity, 1);
  assert.equal(hot.mood, 'pump');
  assert.equal(marketActivity([-5, -4, -6]).mood, 'dump');
  assert.equal(marketActivity([null, undefined]).activity, 0.5, 'no data: middle');
  const fast = marketActivity([1, 1], [3, 2.5]);
  const slow = marketActivity([1, 1], [0.2, 0.3]);
  assert.ok(fast.activity > slow.activity, 'volume velocity raises activity');
  const mk = (closes: number[], vols: number[] = closes.map(() => 100)): Candle[] => closes.map((c, i) => ({ t: i, o: i ? closes[i - 1] : c, h: c * 1.01, l: c * 0.99, c, v: vols[i] }));
  const flat = candleActivity(mk([1, 1, 1, 1, 1, 1]));
  assert.equal(flat.mood, 'neutral');
  assert.ok(flat.activity >= 0.15 && flat.activity < 0.2, 'flat candles idle');
  const pump = candleActivity(mk([1, 1, 1, 1.1, 1.25, 1.4], [100, 100, 100, 150, 300, 500]));
  assert.equal(pump.mood, 'pump');
  assert.ok(pump.activity > 0.8);
  assert.equal(candleActivity(mk([1, 1, 1, 0.95, 0.9, 0.85])).mood, 'dump');
  assert.equal(candleActivity(mk([1, 1, 1, 1, 1, 1]), 9).mood, 'pump', 'a 5 m spike pumps too');
  assert.equal(candleActivity([]).activity, 0.5);
  const v = makeVfx({ seed: 1, intensity: 'fever' });
  v.activity = 0.2;
  blendActivity(v, { activity: 1, mood: 'pump' });
  assert.ok(Math.abs(v.activity - 0.44) < 1e-9);
  assert.equal(v.mood, 'pump');
  blendActivity(v, { activity: 1, mood: 'dump' }, false);
  assert.equal(v.mood, 'pump', 'mood held');
});

test('setSources keeps the user strings and appends kana/hex runs; ascii drops the kana', () => {
  const v = makeVfx({ seed: 1, intensity: 'fever' });
  setSources(v, ['GIGA', 'x', 'ABCDEFGHIJ']);
  assert.ok(v.sources.includes('GIGA') && v.sources.includes('ABCDEFGHIJ') && !v.sources.includes('x'));
  assert.ok(v.sources.length > 10);
  const a = makeVfx({ seed: 1, ascii: true, sources: ['GIGA'] });
  assert.ok(a.sources.every((s) => !KANA.test(s)));
  assert.equal(a.code, CODE_ASCII);
});

test('luminance / contrast follow WCAG (black/white 21:1, theme text ≥ 15:1 on bg)', () => {
  assert.equal(luminance('#000000'), 0);
  assert.equal(luminance('#ffffff'), 1);
  assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 1e-9);
  assert.ok(contrast(T.text, T.bg) > 15);
  assert.ok(contrast(T.dim, T.selBg) >= 4.5, 'dim on the selected row clears the gate (raised after the audit)');
  assert.ok(contrast(THEMES.paper.text, THEMES.paper.bg) > 10);
});
