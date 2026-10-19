import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexToRgb, mix, hexToAnsi256, detectColorDepth, parseColorDepth, rgbToHex, THEMES, THEME_NAMES, nextTheme, isThemeName } from '../src/index.ts';

test('hexToRgb / rgbToHex round trip', () => {
  assert.deepEqual(hexToRgb('#22d3ee'), [0x22, 0xd3, 0xee]);
  assert.equal(rgbToHex(0x22, 0xd3, 0xee), '#22d3ee');
  assert.equal(rgbToHex(300, -5, 10), '#ff000a');
});

test('mix blends linearly', () => {
  assert.equal(mix('#000000', '#ffffff', 0), '#000000');
  assert.equal(mix('#000000', '#ffffff', 1), '#ffffff');
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mix('#0f131b', '#34d399', 0.55), mix('#0f131b', '#34d399', 0.55), 'deterministic');
});

test('hexToAnsi256 picks cube or gray ramp', () => {
  assert.equal(hexToAnsi256('#000000'), 16);
  assert.equal(hexToAnsi256('#ffffff'), 231);
  assert.equal(hexToAnsi256('#ff0000'), 196);
  assert.equal(hexToAnsi256('#00ff00'), 46);
  assert.equal(hexToAnsi256('#0000ff'), 21);
  assert.equal(hexToAnsi256('#808080'), 244);
  assert.equal(hexToAnsi256('#121212'), 233);
  // theme colours land in range
  for (const h of ['#0b0e14', '#22d3ee', '#f472b6', '#fde047', '#f6f3ee']) {
    const i = hexToAnsi256(h);
    assert.ok(i >= 16 && i <= 255, `${h} -> ${i}`);
  }
});

test('detectColorDepth honours NO_COLOR, FORCE_COLOR, COLORTERM, TERM', () => {
  assert.equal(detectColorDepth({ NO_COLOR: '1', COLORTERM: 'truecolor' }), 'none');
  assert.equal(detectColorDepth({ NO_COLOR: '' , COLORTERM: 'truecolor' }), 'truecolor', 'empty NO_COLOR is unset per the spec');
  assert.equal(detectColorDepth({ FORCE_COLOR: '3' }, false), 'truecolor');
  assert.equal(detectColorDepth({ FORCE_COLOR: '0', COLORTERM: 'truecolor' }), 'none');
  assert.equal(detectColorDepth({ COLORTERM: 'truecolor' }), 'truecolor');
  assert.equal(detectColorDepth({ COLORTERM: '24bit' }), 'truecolor');
  assert.equal(detectColorDepth({ TERM: 'xterm-256color' }), '256');
  assert.equal(detectColorDepth({ TERM: 'xterm-256color', TERM_PROGRAM: 'iTerm.app' }), 'truecolor');
  assert.equal(detectColorDepth({ TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' }), '256');
  assert.equal(detectColorDepth({ TERM: 'xterm-kitty' }), 'truecolor');
  assert.equal(detectColorDepth({ TERM: 'dumb' }), 'none');
  assert.equal(detectColorDepth({ COLORTERM: 'truecolor' }, false), 'none', 'not a TTY');
  assert.equal(detectColorDepth({}), '256', 'unknown terminal falls back to 256');
});

test('parseColorDepth accepts the CLI spellings', () => {
  assert.equal(parseColorDepth('truecolor'), 'truecolor');
  assert.equal(parseColorDepth('24bit'), 'truecolor');
  assert.equal(parseColorDepth('256'), '256');
  assert.equal(parseColorDepth('none'), 'none');
  assert.equal(parseColorDepth('mono'), 'none');
  assert.equal(parseColorDepth('lots'), undefined);
  assert.equal(parseColorDepth(undefined), undefined);
});

test('themes: mono first in the cycle, every theme carries the effect tokens', () => {
  assert.deepEqual(THEME_NAMES, ['mono', 'slate', 'cyberspace', 'midnight', 'ember', 'paper']);
  assert.equal(nextTheme(THEMES.mono).name, 'slate');
  assert.equal(nextTheme(THEMES.slate).name, 'cyberspace');
  assert.equal(nextTheme(THEMES.cyberspace).name, 'midnight');
  assert.equal(nextTheme(THEMES.paper).name, 'mono');
  assert.ok(isThemeName('cyberspace') && !isThemeName('neon'));
  for (const name of THEME_NAMES) {
    const t = THEMES[name];
    for (const ramp of [t.rain, t.rainPump, t.rainDump]) { assert.equal(ramp.length, 4); for (const h of ramp) assert.match(h, /^#[0-9a-f]{6}$/); }
    assert.equal(t.logo.length, 3);
    for (const k of ['magenta', 'cyan', 'coral', 'acid', 'glow', 'scan'] as const) assert.match(t[k], /^#[0-9a-f]{6}$/);
  }
  assert.equal(THEMES.cyberspace.ai, '#d97757', 'Claude coral');
  assert.equal(THEMES.paper.scan, '#ffffff');
});
