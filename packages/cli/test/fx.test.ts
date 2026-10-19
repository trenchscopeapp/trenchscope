// The practicality rules of VISUAL-V2 §6, ported from prototype-v2/tools/check.mjs into the suite:
//   1. determinism: the same --frame renders byte-identical ANSI and plain output, in-process and via the CLI
//   2. hard-cell invariant: with effects ON, every data cell of the calm render keeps its glyph and colour
//      (headings may take the colour split; their glyphs still may not change)
//   3. colour modes: NO_COLOR emits no colour SGR, --color 256 only 38;5/48;5, truecolor 38;2/48;2
//   4. calm: DEXTERM_CALM=1 / --calm / --intensity off render no rain glyphs and no scanline tint
//   5. effects on: rain glyphs are present, only in zones, and never where a hard cell is
//   6. the intensity tiers, the reduced-motion default under NO_COLOR, the demo events and the boot screen
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { KATAKANA, THEMES, blinkFrames, type ScreenKey } from '@dexterm/tui';
import { main, parseArgs, stateFromArgs, applyEffectArgs, intensityFor, fpsFor, demoEvent, makeFixtureState, renderFrame, mulberry32, type AppState } from '../src/index.ts';

const SCREENS: ScreenKey[] = ['screener', 'token', 'newpairs', 'watchlist', 'analyst'];
const SIZES = [[176, 48], [120, 40], [90, 36]] as const;
const KANA = new RegExp(`[${KATAKANA}]`);

function fakeIo(env: NodeJS.ProcessEnv = {}) {
  let out = '';
  let err = '';
  const stdout = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } }) as unknown as NodeJS.WriteStream & { fd: 1 };
  const stderr = new Writable({ write(chunk, _enc, cb) { err += chunk.toString(); cb(); } }) as unknown as NodeJS.WriteStream & { fd: 2 };
  Object.assign(stdout, { isTTY: false, columns: 120, rows: 40 });
  const stdin = { isTTY: false } as unknown as NodeJS.ReadStream & { fd: 0 };
  return { io: { stdout, stderr, stdin, env: { DEXTERM_OFFLINE: '1', ...env } }, out: () => out, err: () => err };
}

async function cli(argv: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const f = fakeIo(env);
  assert.equal(await main(argv, f.io), 0, f.err());
  return f.out();
}

function fxState(screen: ScreenKey, extra: string[] = []): AppState {
  // effects are off by default; these tests exercise them, so ask for fever (--calm / --intensity in extra still win)
  const args = parseArgs(['--fixtures', '--screen', screen, '--frame', '41', '--selected', '3', '--intensity', 'fever', ...extra]);
  const st = stateFromArgs(args);
  applyEffectArgs(st, args);
  return st;
}

test('determinism: the same --frame renders byte-identical ANSI and plain output for every screen (CLI)', async () => {
  for (const s of [...SCREENS, 'boot' as const]) {
    const a = ['--screen', s, '--fixtures', '--width', '120', '--height', '40', '--frame', '40', '--selected', '3', '--t', '0.78'];
    assert.equal(await cli([...a, '--ansi']), await cli([...a, '--ansi']), `${s} ansi`);
    assert.equal(await cli([...a, '--plain']), await cli([...a, '--plain']), `${s} plain`);
  }
});

test('determinism: renderFrame is a pure function of (state, frame); a different frame moves the rain', () => {
  const a = renderFrame(fxState('screener'), 176, 48).toAnsi();
  const b = renderFrame(fxState('screener'), 176, 48).toAnsi();
  assert.equal(a, b);
  const c = renderFrame(fxState('screener', ['--frame', '42']), 176, 48).toPlain();
  assert.notEqual(renderFrame(fxState('screener'), 176, 48).toPlain(), c, 'frame 41 and 42 differ');
});

test('hard-cell invariant: effects never change the glyph or colour of a data cell, at 176/120/90 on all five screens', () => {
  for (const s of SCREENS) {
    for (const [w, h] of SIZES) {
      const calm = renderFrame(fxState(s, ['--calm']), w, h);
      const fx = renderFrame(fxState(s), w, h);
      const inHeading = new Uint8Array(calm.ch.length);
      for (const hd of fx.headings) for (let k = 0; k < hd.w; k++) inHeading[fx.idx(hd.x + k, hd.y)] = 1;
      let badGlyph = 0, badFg = 0, hard = 0, rainCells = 0;
      for (let i = 0; i < calm.ch.length; i++) {
        const y = Math.floor(i / w);
        if (calm.hard[i]) {
          if (y === 0 || y === h - 1) continue; // header/footer carry a "· calm" label in calm mode: different text, not an effect
          hard += 1;
          if (calm.ch[i] !== fx.ch[i]) badGlyph += 1;
          else if (!inHeading[i] && calm.fg[i] !== fx.fg[i]) badFg += 1;
        } else if (calm.ch[i] === ' ' && fx.ch[i] !== ' ') {
          if (y === 0 || y === h - 1) continue; // the header/footer calm label shifts the status cluster
          // a cell the effects filled: it must be inside a rain zone (ghost glyphs sit next to headings)
          rainCells += 1;
          const nearHeading = inHeading[i - 1] || inHeading[i + 1];
          assert.ok(fx.zone[i] || nearHeading, `${s} @${w}: effect glyph '${fx.ch[i]}' outside a rain zone at ${i % w},${y}`);
        }
      }
      assert.ok(hard > 200, `${s} @${w}: ${hard} hard cells`);
      assert.equal(badGlyph, 0, `${s} @${w}: ${badGlyph} data glyphs changed by effects`);
      assert.equal(badFg, 0, `${s} @${w}: ${badFg} data colours changed by effects`);
      assert.ok(rainCells >= 10, `${s} @${w}: rain present (${rainCells} cells)`);
    }
  }
});

test('the --event demo renders mutate the data the same way the loop would and pulse the effects', () => {
  const pump = fxState('token', ['--event', 'pump']);
  assert.equal(pump.vfx.mood, 'pump');
  assert.equal(pump.vfx.activity, 1);
  assert.match(renderFrame(pump, 176, 50).toPlain(), /▲ PUMPING/);
  const dump = fxState('token', ['--event', 'dump']);
  assert.equal(dump.vfx.mood, 'dump');
  assert.match(renderFrame(dump, 176, 50).toPlain(), /▼ DUMPING/);
  const np = fxState('newpairs', ['--event', 'newpair', '--selected', '0']);
  assert.ok(np.vfx.glitch >= 0.8);
  assert.equal(np.vfx.stutter, 2);
  assert.match(renderFrame(np, 176, 46).toPlain(), /NEW (WAGMI|JEET|NGMI|COPIUM|REKT)/);
  const rug = fxState('newpairs', ['--event', 'rug', '--selected', '0']);
  assert.equal(rug.vfx.glitch, 1);
  assert.equal(rug.vfx.mood, 'dump');
  assert.equal(rug.fx.newPairs[0].flags[0], 'RUG');
  assert.match(renderFrame(rug, 200, 46).toPlain(), /RUG/, 'the RISK column shows the flag where it fits (200 columns)');
  assert.throws(() => parseArgs(['--event', 'pump']), /--event is a fixture demo event/);
  assert.throws(() => parseArgs(['--fixtures', '--event', 'moon']), /unknown event/);
  // in-loop demo events through the same helper
  const st = makeFixtureState({ screen: 'screener' });
  const rnd = mulberry32(5);
  assert.match(demoEvent(st, 'pump', rnd), /▲38% 5m/);
  assert.match(demoEvent(st, 'newpair', rnd), /new pair \$/);
  assert.match(demoEvent(st, 'rug', rnd), /RUG FLAG/);
});

test('analyst states: thinking shows the Claude-Code spinner line; streaming decrypts the next lines', () => {
  const thinking = renderFrame(fxState('token', ['--ai', 'thinking']), 176, 50).toPlain();
  assert.match(thinking, /[·✢✳✶✻✽] (Thinking|Reading holders|Checking rugcheck|Decrypting)…/);
  assert.match(thinking, /esc to interrupt/);
  const streaming = renderFrame(fxState('token', ['--ai', 'streaming:40']), 176, 50).toPlain();
  assert.match(streaming, /● (WATCH|AVOID|SPECULATIVE)/, 'the verdict line is the first streaming line');
  const full = renderFrame(fxState('analyst', ['--ai', 'streaming:30']), 176, 46).toPlain();
  assert.match(full, /✦ Ranked by holder velocity/);
  assert.throws(() => parseArgs(['--ai', 'sleeping']), /bad --ai/);
});

test('colour modes: NO_COLOR has no colour SGR (and implies calm), --color 256 only 38;5, truecolor 38;2', async () => {
  const probe = ['--screen', 'screener', '--fixtures', '--width', '120', '--height', '40', '--frame', '40', '--ansi'];
  const none = await cli(probe, { NO_COLOR: '1' });
  assert.doesNotMatch(none, /38;2|48;2|38;5|48;5/);
  assert.match(none, /◉ live · calm/, 'NO_COLOR is the reduced-motion default');
  assert.doesNotMatch(none, KANA);
  const c256 = await cli([...probe, '--color', '256', '--intensity', 'fever']);
  assert.match(c256, /38;5;\d+;48;5;\d+m/);
  assert.doesNotMatch(c256, /38;2;/);
  assert.match(c256, KANA, '256-colour still rains');
  const tc = await cli([...probe, '--color', 'truecolor']);
  assert.match(tc, /38;2;\d+;\d+;\d+;48;2;/);
});

test('calm: --calm, DEXTERM_CALM=1 and --intensity off render no rain glyphs and no scanline tint; effects on render rain', async () => {
  const probe = ['--screen', 'screener', '--fixtures', '--width', '120', '--height', '40', '--frame', '40', '--plain'];
  for (const [argv, env] of [[[...probe, '--calm'], {}], [probe, { DEXTERM_CALM: '1' }], [[...probe, '--intensity', 'off'], {}]] as const) {
    const out = await cli([...argv], env);
    assert.doesNotMatch(out, KANA, JSON.stringify(argv));
    assert.match(out, /◉ live · calm/);
  }
  const busy = await cli([...probe, '--intensity', 'fever']);
  assert.match(busy, KANA, 'effects on: rain glyphs present');
  assert.doesNotMatch(busy, /· calm/);
  // scanlines: odd rows' bg are pulled toward scan with effects on, untouched in calm (checked on a panel cell:
  // on the near-black page background the 7 % pull rounds away to nothing)
  const fx = renderFrame(fxState('screener'), 120, 40);
  const calm = renderFrame(fxState('screener', ['--calm']), 120, 40);
  const odd = calm.idx(3, 7), even = calm.idx(3, 8);
  assert.notEqual(calm.bg[odd], calm.theme.bg);
  assert.notEqual(fx.bg[odd], calm.bg[odd], 'odd row tinted');
  assert.equal(fx.bg[even], calm.bg[even], 'even row untouched');
});

test('intensity tiers: calm (off) is the default, normal halves the frame cap and rains sparser, env and flags resolve in order', () => {
  assert.equal(intensityFor({ calm: false, intensity: null }, {}, 'truecolor'), 'off');
  assert.equal(intensityFor({ calm: true, intensity: 'fever' }, {}, 'truecolor'), 'off', '--calm wins');
  assert.equal(intensityFor({ calm: false, intensity: null }, { DEXTERM_CALM: '1' }, 'truecolor'), 'off');
  assert.equal(intensityFor({ calm: false, intensity: 'normal' }, { DEXTERM_INTENSITY: 'fever' }, 'truecolor'), 'normal', 'flag beats env');
  assert.equal(intensityFor({ calm: false, intensity: null }, { DEXTERM_INTENSITY: 'normal' }, 'truecolor'), 'normal');
  assert.equal(intensityFor({ calm: false, intensity: null }, { NO_COLOR: '1' }, 'none'), 'off');
  assert.equal(intensityFor({ calm: false, intensity: 'fever' }, { NO_COLOR: '1' }, 'none'), 'fever', 'explicit tier beats NO_COLOR');
  assert.equal(fpsFor({ fps: null }, 'fever'), 30);
  assert.equal(fpsFor({ fps: null }, 'normal'), 15);
  assert.equal(fpsFor({ fps: 12 }, 'fever'), 12);
  assert.throws(() => parseArgs(['--fps', '0']), /--fps expects/);
  assert.throws(() => parseArgs(['--intensity', 'max']), /unknown intensity/);
  const fever = renderFrame(fxState('screener'), 176, 48);
  const normal = renderFrame(fxState('screener', ['--intensity', 'normal']), 176, 48);
  const count = (c: typeof fever) => c.ch.filter((ch, i) => !c.hard[i] && KANA.test(ch)).length;
  assert.ok(count(normal) < count(fever), `normal rains sparser (${count(normal)} < ${count(fever)})`);
  assert.equal(fxState('screener', ['--intensity', 'normal']).vfx.baseline, 0, 'no idle aberration on normal');
});

test('boot screen: logo, jacking-in lines and the press-any-key line appear with t; rain stays off the logo and the status box', () => {
  const early = renderFrame(fxState('boot', ['--t', '0.1', '--frame', '3']), 176, 48).toPlain();
  assert.match(early, /█████/);
  assert.doesNotMatch(early, /JACKED IN/);
  const late = renderFrame(fxState('boot', ['--t', '0.95', '--frame', '30']), 176, 48);
  const plain = late.toPlain();
  assert.match(plain, /JACKING IN/);
  assert.match(plain, /dexscreener\s+GET \/latest\/dex\/search/);
  assert.match(plain, /◉ JACKED IN · press any key/);
  assert.match(plain, /fixtures\s+34 tokens/);
  assert.match(plain, KANA, 'full-screen rain');
  // the status box (76 columns from the ▸) carries no rain glyphs: its zone is cleared
  const box = plain.split('\n').filter((l) => /▸/.test(l));
  assert.ok(box.length >= 7);
  for (const l of box) { const k = l.indexOf('▸'); assert.doesNotMatch(l.slice(k, k + 76), KANA, l); }
  const logoRows = late.toPlain().split('\n').filter((l) => /█████/.test(l));
  for (const l of logoRows) { const k = l.indexOf('█'); assert.doesNotMatch(l.slice(k - 2, k + 45), KANA, 'rain stays off the logo'); }
  assert.throws(() => parseArgs(['--t', '2']), /--t expects/);
});

test('blink frames stay within 350 ms at every cap', () => {
  for (const fps of [1, 4, 10, 15, 24, 30, 60]) {
    const n = blinkFrames(fps);
    assert.ok(n >= 4 && n <= 11, `fps ${fps}: ${n}`);
    if (fps >= 12) assert.ok((n / fps) * 1000 <= 350 + 1e-9, `fps ${fps}: ${(n / fps) * 1000} ms`);
  }
});

test('--html --fit writes a video-frame page with ch-pinned runs and no window chrome; --ascii-rain drops the katakana', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-'));
  try {
    const file = join(dir, 'f.html');
    await cli(['--screen', 'token', '--fixtures', '--width', '160', '--height', '45', '--frame', '40', '--html', file, '--fit', '1920x1080', '--font', '17']);
    const html = readFileSync(file, 'utf8');
    assert.match(html, /width:1920px;height:1080px/);
    assert.match(html, /width:\d+ch;overflow:hidden;/);
    assert.doesNotMatch(html, /class="bar"/);
    assert.match(html, /font-size:17px/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.throws(() => parseArgs(['--fit', 'wide']), /--fit expects WxH/);
  const ascii = await cli(['--screen', 'screener', '--fixtures', '--width', '120', '--height', '40', '--frame', '40', '--plain', '--ascii-rain']);
  assert.doesNotMatch(ascii, KANA);
  const posix = await cli(['--screen', 'screener', '--fixtures', '--width', '120', '--height', '40', '--frame', '40', '--plain'], { LANG: 'C' });
  assert.doesNotMatch(posix, KANA, 'LANG=C falls back to hex rain');
});

test('every theme renders every screen with effects on, and the mono theme is the default', () => {
  for (const name of ['mono', 'slate', 'cyberspace', 'midnight', 'ember', 'paper'] as const) {
    for (const s of SCREENS) {
      const st = makeFixtureState({ screen: s, theme: THEMES[name], frame: 41, intensity: 'fever' });
      assert.doesNotThrow(() => renderFrame(st, 120, 40), `${name}/${s}`);
    }
  }
  assert.equal(makeFixtureState().theme.name, 'mono');
});
