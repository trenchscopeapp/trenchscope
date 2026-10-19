// task-1358 Tier 2 — user themes and keymap overrides in the app: --theme <user theme>, the t cycle, a refused
// theme never loads, config.keymap rebinds keys (reserved ones refused with the defaults kept), the ? help
// marks overrides, and the theme/keymap subcommands. Fixtures only; DEXTERM_HOME is a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKeys, THEMES, THEME_NAMES, DEFAULT_KEYMAP } from '@dexterm/tui';
import { saveConfig, defaultConfig, checkThemeSemantics } from '@dexterm/custom';
import { applyKey, main } from '../src/main.ts';
import { makeFixtureState, renderFrame } from '../src/state.ts';
import { initCustom, themeByName, themeNames, cycleTheme } from '../src/custom.ts';
import { helpRows } from '../src/screens/overlay.ts';
import { themeCommand, keymapCommand } from '../src/theme-cmd.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dexterm-th-'));
function fakeIo(env: NodeJS.ProcessEnv = {}) {
  let out = ''; let err = '';
  const stdout = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } }) as unknown as NodeJS.WriteStream & { fd: 1 };
  const stderr = new Writable({ write(chunk, _enc, cb) { err += chunk.toString(); cb(); } }) as unknown as NodeJS.WriteStream & { fd: 2 };
  Object.assign(stdout, { isTTY: false, columns: 176, rows: 45 });
  Object.assign(stderr, { isTTY: false });
  const stdin = { isTTY: false } as unknown as NodeJS.ReadStream & { fd: 0 };
  return { io: { stdout, stderr, stdin, env }, out: () => out, err: () => err };
}
const writeTheme = (home: string, name: string, doc: object): void => { mkdirSync(join(home, 'themes'), { recursive: true }); writeFileSync(join(home, 'themes', `${name}.json`), JSON.stringify(doc)); };

test('every built-in theme passes the contrast floor and the up/down hue guard (the cyberspace look is a theme)', () => {
  for (const n of THEME_NAMES) assert.deepEqual(checkThemeSemantics(THEMES[n] as unknown as Record<string, unknown>), [], n);
});

test('a user theme file joins the t cycle after the built-ins and resolves over its base; a failing one is skipped and reported', () => {
  const home = tmp();
  writeTheme(home, 'amber', { extends: 'cyberspace', tokens: { accent: '#ffb02e', borderFocus: '#ffd060' } });
  writeTheme(home, 'blind', { extends: 'cyberspace', tokens: { warn: '#0a0c10' } });
  const state = makeFixtureState();
  state.custom = initCustom({ DEXTERM_HOME: home });
  assert.deepEqual(themeNames(state.custom), [...THEME_NAMES, 'amber', 'blind']);
  const amber = themeByName(state.custom, 'amber');
  assert.equal(amber?.name, 'amber');
  assert.equal(amber?.accent, '#ffb02e');
  assert.equal(amber?.up, THEMES.cyberspace.up);
  assert.equal(themeByName(state.custom, 'blind'), null);
  assert.ok(state.custom.themeErrors.some((e) => /theme blind: \/tokens\/warn/.test(e)), state.custom.themeErrors.join('; '));
  // t cycles: mono → slate → cyberspace → midnight → ember → paper → amber → (blind skipped) → mono
  state.theme = THEMES.paper;
  for (const k of parseKeys('t')) applyKey(state, k, []);
  assert.equal(state.theme.name, 'amber');
  for (const k of parseKeys('t')) applyKey(state, k, []);
  assert.equal(state.theme.name, 'mono');
  assert.equal(cycleTheme(null, THEMES.paper).name, 'mono', 'without a config the cycle is the built-ins only');
  // the frame actually renders in the user theme
  state.theme = amber!;
  const c = renderFrame(state, 120, 40);
  assert.ok(c.toAnsi({ depth: 'truecolor' }).includes('255;176;46'), 'the amber accent is painted');
});

test('config.theme.overrides patch the active theme and are held to the floors', () => {
  const home = tmp();
  saveConfig(home, { ...defaultConfig(), theme: { name: 'cyberspace', overrides: { accent: '#ff00ff' }, user: {} } });
  const ui = initCustom({ DEXTERM_HOME: home });
  assert.equal(themeByName(ui, 'cyberspace')?.accent, '#ff00ff');
  assert.equal(themeByName(ui, 'ember')?.accent, '#ff00ff', 'overrides apply to every theme');
  saveConfig(home, { ...defaultConfig(), theme: { name: 'cyberspace', overrides: { text: '#000000' }, user: {} } });
  const ui2 = initCustom({ DEXTERM_HOME: home });
  assert.equal(themeByName(ui2, 'cyberspace')?.text, THEMES.cyberspace.text, 'a refused override is ignored');
  assert.ok(ui2.themeErrors.some((e) => /theme overrides: \/theme\/overrides\/text/.test(e)));
});

test('--theme <user theme> renders a one-shot frame; an unknown or refused theme is exit 2, never a silent default', async () => {
  const home = tmp();
  writeTheme(home, 'amber', { extends: 'midnight', tokens: { accent: '#ffb02e' } });
  writeTheme(home, 'blind', { extends: 'cyberspace', tokens: { text: '#101010' } });
  const ok = fakeIo({ DEXTERM_HOME: home, DEXTERM_OFFLINE: '1' });
  assert.equal(await main(['--screen', 'screener', '--fixtures', '--ansi', '--width', '120', '--height', '40', '--theme', 'amber'], ok.io), 0);
  assert.ok(ok.out().includes('255;176;46'));
  const no = fakeIo({ DEXTERM_HOME: home, DEXTERM_OFFLINE: '1' });
  assert.equal(await main(['--screen', 'screener', '--fixtures', '--plain', '--theme', 'nope'], no.io), 2);
  assert.match(no.err(), /unknown theme nope \(have: mono \| slate \| cyberspace \| midnight \| ember \| paper \| amber \| blind\)/);
  const bl = fakeIo({ DEXTERM_HOME: home, DEXTERM_OFFLINE: '1' });
  assert.equal(await main(['--screen', 'screener', '--fixtures', '--plain', '--theme', 'blind'], bl.io), 2);
  assert.match(bl.err(), /theme blind: \/tokens\/text .*floor/);
});

test('config.keymap rebinds a global action and a screen action; the help card marks them; reserved keys refuse the whole keymap', () => {
  const home = tmp();
  saveConfig(home, { ...defaultConfig(), keymap: { global: { 'theme.next': ['e'] }, screens: { screener: { 'sort.menu': ['o'] } } } });
  const state = makeFixtureState();
  state.custom = initCustom({ DEXTERM_HOME: home });
  assert.deepEqual(state.custom.configErrors, []);
  const before = state.theme.name;
  for (const k of parseKeys('t')) applyKey(state, k, []);
  assert.equal(state.theme.name, before, 't no longer cycles the theme');
  for (const k of parseKeys('e')) applyKey(state, k, []);
  assert.notEqual(state.theme.name, before, 'e does');
  for (const k of parseKeys('o')) applyKey(state, k, []);
  assert.equal(state.screener.mode, 'sort', 'o opens the sort menu on the screener');
  const ov = new Set(state.custom.keymapResult.overridden.map((o) => `${o.screen ?? ''}|${o.action}`));
  const rows = helpRows('screener', false, state.custom.keymap, ov);
  assert.ok(rows.some((r) => r.keys === 'e' && r.label === 'theme ·'), JSON.stringify(rows.filter((r) => /theme/.test(r.label))));
  assert.ok(rows.some((r) => r.keys === 'o' && r.label === 'sort ·'));
  // T is the TRENDING key globally: binding theme.next to T collides → refused, defaults kept
  saveConfig(home, { ...defaultConfig(), keymap: { global: { 'theme.next': ['T'] } } });
  const col = initCustom({ DEXTERM_HOME: home });
  assert.ok(col.configErrors.some((e) => /"T" is bound to both theme.next and screen.trending/.test(e)), col.configErrors.join('; '));
  assert.equal(col.keymap, DEFAULT_KEYMAP);
  saveConfig(home, { ...defaultConfig(), keymap: { global: { 'theme.next': ['y'], 'alert.confirm': ['Q'] } } });
  const s2 = makeFixtureState();
  s2.custom = initCustom({ DEXTERM_HOME: home });
  assert.ok(s2.custom.configErrors.some((e) => /keymap \/keymap\/global\/theme.next: "y" is reserved/.test(e)));
  assert.ok(s2.custom.configErrors.some((e) => /alert.confirm.*reserved/.test(e)));
  assert.equal(s2.custom.keymap, DEFAULT_KEYMAP, 'the defaults are in use');
  for (const k of parseKeys('t')) applyKey(s2, k, []);
  assert.notEqual(s2.theme.name, 'mono', 't still cycles');
});

test('trenchscope theme list | init | show | check and trenchscope keymap', async () => {
  const home = tmp();
  const env = { DEXTERM_HOME: home };
  let io = fakeIo(env);
  assert.equal(await themeCommand(['init', 'mine', '--extends', 'ember'], io.io), 0);
  assert.match(io.out(), /wrote .*themes[\\/]mine\.json/);
  io = fakeIo(env);
  assert.equal(await themeCommand(['list'], io.io), 0);
  assert.match(io.out(), /cyberspace\s+built-in/);
  assert.match(io.out(), /mine\s+file · extends ember · 2 token\(s\)/);
  io = fakeIo(env);
  assert.equal(await themeCommand(['show', 'mine'], io.io), 0);
  const shown = JSON.parse(io.out());
  assert.equal(shown.name, 'mine');
  assert.equal(shown.bg, THEMES.ember.bg);
  const bad = join(home, 'bad.json');
  writeFileSync(bad, JSON.stringify({ extends: 'cyberspace', tokens: { up: '#ff0000', down: '#00ff00' } }));
  io = fakeIo(env);
  assert.equal(await themeCommand(['check', bad], io.io), 1);
  assert.match(io.out(), /✗ \/tokens\/up .*swapped/);
  io = fakeIo(env);
  assert.equal(await themeCommand(['check', join(home, 'themes', 'mine.json')], io.io), 0);
  io = fakeIo(env);
  assert.equal(await themeCommand(['init', 'cyberspace'], io.io), 2);
  io = fakeIo(env);
  assert.equal(await keymapCommand([], io.io), 0);
  assert.match(io.out(), /global\s+quit\s+q \/ ctrl\+c/);
  saveConfig(home, { ...defaultConfig(), keymap: { global: { 'theme.next': ['e'] } } });
  io = fakeIo(env);
  assert.equal(await keymapCommand(['screener'], io.io), 0);
  assert.match(io.out(), /· global\s+theme\.next\s+e/);
  assert.ok(!/token\s+tf\.1/.test(io.out()), 'a screen filter hides other screens');
  saveConfig(home, { ...defaultConfig(), keymap: { global: { 'theme.next': ['T'] } } });
  io = fakeIo(env);
  assert.equal(await keymapCommand([], io.io), 1, 'a colliding keymap exits 1 and says the defaults are in use');
  assert.match(io.out(), /bound to both/);
});
