// task-1358 Tier 2 — user themes: merge over a base, hex + contrast + hue validation, overrides, files on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTheme, applyOverrides, checkThemeSemantics, listUserThemes, contrast, starterTheme, deltaE, UP_DOWN_MIN_SATURATION, UP_DOWN_MIN_DELTA_E, type ThemeDoc } from '../src/themes.ts';

// a stand-in for @dexterm/tui's cyberspace theme (the real one is checked in the cli test)
const CYBER: ThemeDoc = {
  name: 'cyberspace', bg: '#020507', panel: '#03090c', panelAlt: '#051017', border: '#0c3a24', borderFocus: '#39ff14', text: '#eafff0', muted: '#62c98a', dim: '#3aa866',
  accent: '#00f0ff', accentSoft: '#043a40', up: '#5dff6e', upSoft: '#0a3a16', down: '#ff3b6b', downSoft: '#3d0a1a', warn: '#f5ff2d', warnSoft: '#35380a', ai: '#d97757', aiSoft: '#3a1a10',
  pump: '#ff2bd6', dbc: '#ff8a3d', raydium: '#00f0ff', meteora: '#ffb02e', bonk: '#f5ff2d', selBg: '#082618', headBg: '#020a08', tabActiveBg: '#0b3b22', sparkUp: '#5dff6e', sparkDown: '#ff3b6b',
  heat: ['#062013', '#0a4a2a', '#13a04a', '#39ff14'], rain: ['#06301a', '#0b5a2c', '#16a848', '#b8ffc8'], rainPump: ['#3a2a05', '#8a6410', '#f0b429', '#fff1b3'], rainDump: ['#3a0a12', '#7a1226', '#d12a4a', '#ffb3c1'],
  magenta: '#ff2bd6', cyan: '#00f0ff', coral: '#d97757', acid: '#f5ff2d', glow: '#0f4d2a', scan: '#000000', logo: ['#39ff14', '#00f0ff', '#ff2bd6'],
};
const bases = { cyberspace: CYBER };

test('a user theme merges its tokens over the base and keeps everything else', () => {
  const r = resolveTheme({ name: 'amber', extends: 'cyberspace', tokens: { accent: '#ffb02e', rain: ['#2a1c05', '#6a4a10', '#c08a20', '#ffe6a0'] } }, bases);
  assert.deepEqual(r.errors, []);
  assert.equal(r.theme?.name, 'amber');
  assert.equal(r.theme?.accent, '#ffb02e');
  assert.deepEqual(r.theme?.rain, ['#2a1c05', '#6a4a10', '#c08a20', '#ffe6a0']);
  assert.equal(r.theme?.up, CYBER.up, 'untouched tokens come from the base');
  assert.equal(CYBER.accent, '#00f0ff', 'the base is not mutated');
});

test('schema: non-hex tokens, unknown tokens, a 3-colour ramp and an unknown base are refused by path', () => {
  assert.ok(resolveTheme({ name: 'x', extends: 'cyberspace', tokens: { up: 'green' } }, bases).errors.some((e) => e.path === '/tokens/up'));
  assert.ok(resolveTheme({ name: 'x', extends: 'cyberspace', tokens: { shell: '#000000' } as never }, bases).errors.some((e) => e.path === '/tokens/shell' && e.msg === 'unknown key'));
  assert.ok(resolveTheme({ name: 'x', extends: 'cyberspace', tokens: { heat: ['#000000', '#111111', '#222222', '#333333', '#444444'] } }, bases).errors.some((e) => e.path === '/tokens/heat'));
  assert.ok(resolveTheme({ name: 'x', extends: 'solarized' as never }, bases).errors.length);
});

test('contrast floor: a theme that hides warnings or numbers is refused and names the pair', () => {
  const lowWarn = resolveTheme({ name: 'x', extends: 'cyberspace', tokens: { warn: '#101418' } }, bases);
  assert.equal(lowWarn.theme, null);
  assert.ok(lowWarn.errors.some((e) => e.path === '/tokens/warn' && /under the 3 floor/.test(e.msg) && /hide warnings/.test(e.msg)), JSON.stringify(lowWarn.errors));
  const lowText = resolveTheme({ name: 'x', extends: 'cyberspace', tokens: { text: '#223344' } }, bases);
  assert.ok(lowText.errors.some((e) => e.path === '/tokens/text' && /4.5 floor/.test(e.msg)));
  assert.ok(contrast('#ffffff', '#000000') > 20);
});

test('hue guard: up and down cannot be swapped; a cyan up and a pink down pass', () => {
  const swapped = resolveTheme({ name: 'x', extends: 'cyberspace', tokens: { up: '#ff3b6b', down: '#5dff6e' } }, bases);
  assert.equal(swapped.theme, null);
  assert.ok(swapped.errors.some((e) => /swapped|reads red/.test(e.msg)));
  const redUp = resolveTheme({ name: 'x', extends: 'cyberspace', tokens: { up: '#ff2020' } }, bases);
  assert.ok(redUp.errors.some((e) => e.path === '/tokens/up'));
  const ok = resolveTheme({ name: 'x', extends: 'cyberspace', tokens: { up: '#22e5ff', down: '#ff5fb0' } }, bases);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(checkThemeSemantics(CYBER), []);
});

test('overrides patch one token of a resolved theme and are held to the same floors', () => {
  const ok = applyOverrides(CYBER, { accent: '#ff00ff' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.theme.accent, '#ff00ff');
  const bad = applyOverrides(CYBER, { text: '#000000' });
  assert.equal(bad.theme, CYBER, 'a refused override leaves the theme as it was');
  assert.ok(bad.errors.some((e) => e.path === '/theme/overrides/text'));
  const junk = applyOverrides(CYBER, { exec: '#000000' } as never);
  assert.ok(junk.errors.some((e) => e.path === '/theme/overrides/exec'));
});

test('themes on disk: file name = theme name, built-in names and bad files are reported not thrown, config.theme.user merges', () => {
  const home = mkdtempSync(join(tmpdir(), 'dexterm-themes-'));
  mkdirSync(join(home, 'themes'));
  writeFileSync(join(home, 'themes', 'amber.json'), JSON.stringify({ extends: 'cyberspace', tokens: { accent: '#ffb02e' } }));
  writeFileSync(join(home, 'themes', 'cyberspace.json'), JSON.stringify({ extends: 'midnight' }));
  writeFileSync(join(home, 'themes', 'broken.json'), '{');
  writeFileSync(join(home, 'themes', 'wrong.json'), JSON.stringify({ name: 'other', extends: 'cyberspace' }));
  writeFileSync(join(home, 'themes', 'evil.json'), JSON.stringify({ extends: 'cyberspace', tokens: { up: '$(rm -rf ~)' } }));
  const list = listUserThemes(home, { version: 3, theme: { user: { inline: { extends: 'paper', tokens: {} } } } });
  const by = Object.fromEntries(list.map((t) => [t.name, t]));
  assert.equal(by.inline.path, null);
  assert.equal(by.amber.doc.tokens?.accent, '#ffb02e');
  assert.match(by.cyberspace.error ?? '', /built-in/);
  assert.match(by.broken.error ?? '', /JSON/);
  assert.match(by.wrong.error ?? '', /must be "wrong"/);
  assert.match(by.evil.error ?? '', /\/tokens\/up/);
  assert.equal(starterTheme('mine').extends, 'cyberspace');
});

test('r4 (verifier): the hue guard requires up to read GREEN/CYAN and down to read RED/PINK — up == down, amber/amber, blue down and out-of-band hues are refused; every built-in up/down pair passes', () => {
  const sem = (up: string, down: string): string[] => checkThemeSemantics({ ...CYBER, up, down }).map((e) => `${e.path}: ${e.msg}`);
  // the finding: identical up/down (amber) used to pass "up/down hue"
  const same = sem('#ffaa00', '#ffaa00');
  assert.ok(same.some((m) => /\/tokens\/up: .*must read green\/cyan/.test(m)), same.join(' | '));
  assert.ok(same.some((m) => /\/tokens\/down: .*must read red\/pink/.test(m)), same.join(' | '));
  assert.ok(same.some((m) => /down equals up/.test(m)), same.join(' | '));
  // hues between the bands (26..59 and 201..319) are neither green nor red: refused on whichever side they sit
  assert.ok(sem('#ffaa00', '#ff3b6b').some((m) => /\/tokens\/up: \(?.*hue 40°/.test(m)), 'amber up (hue 40) refused');
  assert.ok(sem('#5dff6e', '#4040ff').some((m) => /\/tokens\/down: .*hue 240°.*must read red\/pink/.test(m)), 'blue down (hue 240) refused');
  assert.ok(sem('#5dff6e', '#ff8800').some((m) => /\/tokens\/down: .*hue 32°/.test(m)), 'orange down (hue 32) refused');
  assert.ok(sem('#8800ff', '#ff3b6b').some((m) => /\/tokens\/up: .*hue 272°/.test(m)), 'violet up refused');
  // the swap is still named as a swap
  assert.ok(sem('#ff3b6b', '#5dff6e').some((m) => /up and down are swapped/.test(m)));
  // the real pairs: cyberspace and the other built-ins (@dexterm/tui theme.ts) all pass
  for (const [up, down] of [['#5dff6e', '#ff3b6b'], ['#34d399', '#f87171'], ['#4ade80', '#fb7185'], ['#15803d', '#b91c1c']]) assert.deepEqual(sem(up, down), [], `${up}/${down}`);
  // through resolveTheme: the amber/amber theme is NOT loaded
  const r = resolveTheme({ name: 'amber-both', extends: 'cyberspace', tokens: { up: '#ffaa00', down: '#ffaa00' } }, bases);
  assert.equal(r.theme, null); assert.ok(r.errors.length >= 2);
});

test('r5 (verifier): near-grey up/down pairs are refused even when their hues fall in the bands — a saturation floor and a ΔE distance; the built-ins clear both by a wide margin', () => {
  const sem = (up: string, down: string): string[] => checkThemeSemantics({ ...CYBER, up, down }).map((e) => `${e.path}: ${e.msg}`);
  for (const [up, down] of [['#7f807f', '#807f7f'], ['#808a80', '#8a8080'], ['#d0d4d0', '#d4d0d0']]) {
    const r = sem(up, down);
    assert.ok(r.some((m) => /\/tokens\/up: .*too grey \(saturation 0\.\d\d < 0\.35\)/.test(m)), `${up}: ${r.join(' | ')}`);
    assert.ok(r.some((m) => /\/tokens\/down: .*too grey/.test(m)), `${down}: ${r.join(' | ')}`);
    assert.ok(r.some((m) => /too alike \(ΔE \d+\.\d < 40\)/.test(m)), `ΔE: ${r.join(' | ')}`);
    assert.ok(deltaE(up, down) < 15, `${up}/${down} ΔE ${deltaE(up, down)}`);
  }
  // a saturated but pale pair is still caught by the distance when it is close; a saturated far-apart pair passes
  assert.ok(sem('#5dff6e', '#ff3b6b').length === 0);
  for (const [up, down] of [['#5dff6e', '#ff3b6b'], ['#34d399', '#f87171'], ['#4ade80', '#fb7185'], ['#15803d', '#b91c1c']]) {
    const sat = (hex: string): number => { const n = parseInt(hex.slice(1), 16); const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255; const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2; return d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)); };
    assert.ok(sat(up) >= 0.6 && sat(down) >= 0.6, `${up}/${down} saturation`);
    assert.ok(deltaE(up, down) > 80, `${up}/${down} ΔE ${deltaE(up, down).toFixed(1)}`);
  }
  assert.equal(UP_DOWN_MIN_SATURATION, 0.35); assert.equal(UP_DOWN_MIN_DELTA_E, 40);
  // through resolveTheme: the grey theme is NOT loaded (the verifier's `theme check` case)
  const r = resolveTheme({ name: 'grey', extends: 'cyberspace', tokens: { up: '#7f807f', down: '#807f7f' } }, bases);
  assert.equal(r.theme, null); assert.ok(r.errors.length >= 3);
});
